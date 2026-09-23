declare module '#auth-utils' {
  interface User {
    id: string
    organizationId: string
    email: string
    fullName: string
  }

  interface UserSession {
    permissions: string[]
    allHotels: boolean
    hotelIds: string[]
  }
}

export {}
