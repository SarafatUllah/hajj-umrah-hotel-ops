// Organization-scoped repositories. Every *Repository exported here must have a case for each
// of its methods in tests/integration/security/repositoryRegistry.ts (enforced by a coverage test).
export * from './userRepository'
export * from './roleRepository'
export * from './auditRepository'
export * from './hotelRepository'
export * from './userHotelAccessRepository'
export * from './organizationRepository'
export * from './roomTypeRepository'
