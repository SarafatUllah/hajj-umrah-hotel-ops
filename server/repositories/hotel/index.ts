// Hotel-scoped repositories (organization_id AND hotel_id). Every *Repository exported here must
// have a case for each of its methods in tests/integration/security/repositoryRegistry.ts (enforced
// by a coverage test, which walks this barrel the same way it walks server/repositories/tenant).
export * from './hotelSettingRepository'
export * from './floorRepository'
export * from './roomRepository'
export * from './roomBaseConfigRepository'
export * from './capacityPeriodRepository'
export * from './roomCapacityOverrideRepository'
