// Thrown by requireUser() for an anonymous caller. A class, so callers match
// the type instead of the message text. The message stays "Not authenticated"
// for the legacy actions that pass it to the client.
export class AuthError extends Error {
  constructor() {
    super("Not authenticated");
    this.name = "AuthError";
  }
}
