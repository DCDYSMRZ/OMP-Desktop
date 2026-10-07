/** A deliberate destination request also reselects a retained settings surface. */
export type SettingsDestination = 'appearance' | 'runtime' | 'models' | 'advanced' | 'credentials';
export interface SettingsRequest { destination: SettingsDestination; sequence: number }
