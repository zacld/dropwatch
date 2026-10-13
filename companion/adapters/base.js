// The contract every seller adapter implements. The Companion owns the rules (tier choice, limit checks,
// one checkout, no retries); an adapter only knows how to operate one seller using the customer's own
// signed-in session on this device. Adapters never see Dropwatch server credentials, and the customer's
// seller credentials never leave the device.
//
//   id, name, enabled, reason?            enabled=false → the Companion refuses to run it
//   openSession(session)                  → { signedIn, account, savedCard: { brand, last4 } | null }
//   findEvent(session, eventId)           → { id, name, onSale }
//   enterSale(session, eventId, hooks)    → { access }  waits in the waiting room / queue until it is the
//                                           customer's turn. hooks.onProgress(msg); hooks.customerAction(challenge)
//                                           resolves when the customer completes a check, throws if they don't.
//   getTiers(session, eventId, access)    → [{ name, price, available }]
//   reserve(session, eventId, access, tierName, qty)
//                                         → { id, tier, qty, unitPrice, total, expiresAt }
//                                           throws SoldOut when the tier can no longer cover qty
//   checkout(session, basket, hooks)      → { state: 'confirmed' | 'declined', orderRef? }  submits payment ONCE
//                                           with the saved card; hooks.customerAction for payment checks
//   findOrder(session, { eventId, orderRef }) → { orderRef, tierName, qty, unitPrice, total } | null
//   challengeStatus(challengeId)          → 'pending' | 'approved' | 'rejected' | 'expired'

export class SoldOut extends Error {}
export class SellerError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.code = code;
  }
}
