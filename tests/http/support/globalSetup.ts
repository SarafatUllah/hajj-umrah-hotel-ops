import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

declare module 'vitest' {
  export interface ProvidedContext {
    httpTestBaseUrl: string
  }
}

// fileURLToPath (not `new URL(...).pathname`, which leaves spaces/other characters
// percent-encoded — this repo's directory name has a space in it) so cwd is a real path.
const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const LISTENING_RE = /Listening on (https?:\/\/\S+)/
const HEALTH_POLL_INTERVAL_MS = 200
const HEALTH_POLL_TIMEOUT_MS = 20_000
const SHUTDOWN_GRACE_MS = 5_000

/**
 * Builds the production Nitro artifact once (skippable for local iteration — see
 * HTTP_TEST_SKIP_BUILD in package.json's `test:http` script docs / README), boots it as a real child
 * process bound to an OS-assigned free port (`PORT=0`), waits for `GET /api/health` to answer, and
 * hands the discovered base URL to every test file via Vitest's `provide`/`inject`. Teardown always
 * runs (even if a test throws) and kills the exact child PID it spawned — see the orphan-process
 * check in the Task 8 report for proof no server survives a run.
 */
export default async function setup({ provide }: { provide: <T extends 'httpTestBaseUrl'>(key: T, value: string) => void }): Promise<() => Promise<void>> {
  if (process.env.HTTP_TEST_SKIP_BUILD !== '1') {
    const build = spawnSync('pnpm', ['build'], { cwd: PROJECT_ROOT, stdio: 'inherit' })
    if (build.error || build.status !== 0) {
      throw new Error(`\`pnpm build\` failed (exit code ${build.status}, signal ${build.signal}, spawn error ${build.error}) — cannot start the HTTP test harness against a stale/missing .output artifact`)
    }
  }

  const { child, baseUrl } = await startServer()
  provide('httpTestBaseUrl', baseUrl)

  return async () => {
    await stopServer(child)
  }
}

function startServer(): Promise<{ child: ChildProcessWithoutNullStreams, baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['.output/server/index.mjs'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let settled = false
    let stdoutBuf = ''
    let stderrBuf = ''

    const onStdout = (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8')
      const match = LISTENING_RE.exec(stdoutBuf)
      if (match && !settled) {
        settled = true
        child.stdout.off('data', onStdout)
        child.stderr.off('data', onStderr)
        waitForHealth(match[1]!)
          .then((baseUrl) => resolve({ child, baseUrl }))
          .catch((error) => {
            child.kill('SIGKILL')
            reject(error)
          })
      }
    }
    const onStderr = (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8')
    }

    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)

    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      reject(new Error(`Server process exited before it started listening (code=${code}, signal=${signal}).\n--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`))
    })
  })
}

async function waitForHealth(baseUrl: string): Promise<string> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`)
      if (res.status === 200) return baseUrl
      lastError = new Error(`/api/health responded with status ${res.status}`)
    }
    catch (error) {
      lastError = error
    }
    await delay(HEALTH_POLL_INTERVAL_MS)
  }

  throw new Error(`Timed out waiting for ${baseUrl}/api/health to respond 200 within ${HEALTH_POLL_TIMEOUT_MS}ms: ${String(lastError)}`)
}

/**
 * Reliable teardown: SIGTERM first (graceful — Nitro's setupGracefulShutdown hook), then SIGKILL if
 * the process has not exited within SHUTDOWN_GRACE_MS. `node .output/server/index.mjs` is a single
 * Node process (Nitro's node-server preset does not fork/cluster — verified by reading
 * .output/server/chunks/nitro/nitro.mjs, which calls `server.listen` directly on one process), so no
 * process-group/tree-kill mechanism is needed here: killing this one PID is sufficient.
 */
async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')

  const timedOut = await Promise.race([
    exited.then(() => false),
    delay(SHUTDOWN_GRACE_MS).then(() => true),
  ])

  if (timedOut && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await exited
  }
}
