/**
 * A trusted Guest cleanup could not prove that every untrusted descendant and
 * resource is gone. The only safe recovery is to close CONTROL and let the
 * Host terminate/quarantine the complete VM boundary.
 */
export class GuestContainmentError extends Error {
  readonly code: string = "CAPSULE_GUEST_CONTAINMENT_FAILED";
  readonly fatalGuest = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GuestContainmentError";
  }
}
