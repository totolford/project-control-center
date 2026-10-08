// NEXUS: fingerprint of the deployed NEXUS functions. NEXUS overwrites this file in its
// runtime copy with a hash of the code it copied, then waits until `nexus:ping`
// reports that hash, so the world never opens on functions from a previous version.
export const NEXUS_BUILD = 'dev';
