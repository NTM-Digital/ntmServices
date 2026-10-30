// This deployment's own identity in the Auth DB's `apps` table. It is the
// "app-specific" half of every credential and AI-model lookup.
//
// Read straight from process.env rather than through env.ts: env.ts imports
// this module, so importing back would be a cycle — and the app name is
// bootstrap config that could never come from the credential table anyway.
export const APP_NAME = process.env.APP_NAME || 'ntmservices';
