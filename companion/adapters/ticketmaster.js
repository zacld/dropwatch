// Ticketmaster: the intended first real seller.
//
// This adapter is registered but disabled. Ticketmaster's Purchase Policy (clause 4.10) prohibits
// obtaining tickets through unauthorised automated software, and its queue uses bot detection and
// identity checks. The adapter is implemented only once Ticketmaster authorises Dropwatch, through
// written permission or Partner API access; the route it approves determines how it is written.
//
// Until then the Companion refuses to run it, and the server does not offer Ticketmaster events for
// automated checkout. See the feasibility assessment for the evidence and the plan.

export const ticketmasterAdapter = {
  id: 'ticketmaster',
  name: 'Ticketmaster',
  enabled: false,
  reason: 'Awaiting Ticketmaster authorisation (written permission or Partner API access).',
};
