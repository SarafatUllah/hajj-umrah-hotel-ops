import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const LISTENING_RE = /Listening on (https?:\/\/\S+)/

/**
 * A free TCP port. Nitro treats `PORT=0` as "unset" (falls back to 3000), so extra servers get an explicit
 * port picked by the OS here instead (a tiny race window between closing the probe and the server binding is accepted).
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

export interface ExtraServer {
  baseUrl: string
  stop: () => Promise<void>
}

/**
 * Starts ANOTHER copy of the already-built server (`.output`, built by the harness's global setup) with extra
 * environment variables, on a free port, against the same test database. Used where one process-wide
 * environment cannot cover a case (e.g. demo sign-in enabled vs disabled vs production). The shared harness
 * server and its environment are untouched, so no other test's behaviour changes.
 */
export async function startExtraServer(extraEnv: Record<string, string>): Promise<ExtraServer> {
  const storageDir = await mkdtemp(join(tmpdir(), 'hotel-http-extra-'))
  const port = await freePort()
  const child = spawn('node', ['.output/server/index.mjs'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: storageDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      const timedOut = await Promise.race([exited.then(() => false), delay(5_000).then(() => true)])
      if (timedOut) {
        child.kill('SIGKILL')
        await exited
      }
    }
    await rm(storageDir, { recursive: true, force: true })
  }
  try {
    const baseUrl = await waitForListening(child)
    return { baseUrl, stop }
  }
  catch (error) {
    await stop()
    throw error
  }
}

function waitForListening(child: ChildProcessByStdio<null, Readable, Readable>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`server did not start listening in time; output:\n${output}`)), 20_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const match = LISTENING_RE.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve(match[1]!)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`server exited before listening (code=${code}, signal=${signal}); output:\n${output}`))
    })
  })
}

/** Starts a server that is EXPECTED to refuse to start; resolves with its exit code and output (rejects if it starts listening). */
export async function expectServerToFailStartup(extraEnv: Record<string, string>): Promise<{ code: number | null, output: string }> {
  const port = await freePort()
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['.output/server/index.mjs'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`server did not exit; output so far:\n${output}`)) }, 20_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (LISTENING_RE.test(output)) { clearTimeout(timer); child.kill('SIGKILL'); reject(new Error(`server started although it must refuse to:\n${output}`)) }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, output }) })
  })
}
