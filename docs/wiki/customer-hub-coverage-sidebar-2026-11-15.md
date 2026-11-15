# Customer Hub coverage and sidebar — 2026-11-15 follow-up

## Sidebar

The current SidebarContent already initializes an empty collapsed Set; all seven
groups are expanded. It neither reads nor writes localStorage. No key migration
is needed: legacy persisted values cannot affect this component. Manual changes
survive client navigation but reset when the layout remounts/full page reloads.
The screenshot's collapsed groups cannot be attributed to localStorage from this
code. A component integration check verified seven expanded buttons, manual
collapse, remount reset, and no localStorage access (throwing storage mock).
The contract comment is now explicit. No role-based visibility rules were changed.

## Mail audit and repaired omission

Read-only queries across the four configured Amazon accounts found buyer-mail
threads and seller-send confirmations in amazon@salutem.solutions; the other
three had zero matches for the audited message patterns in the last 30 days.
This does not prove those stores have no Seller Central messages.

Four actual confirmation emails had subject `Your e-mail to` without a recipient
name. The parser required a nonempty name and discarded them. All four carried
an exact order ID. The parser now accepts the empty-name variant, joins only by
exact account/order, and retains the buyer name from buyer mail. Parsed-cache
keys include parser-v3 so the old cached omission cannot survive deployment.
A regression test covers the blank subject recipient and exact-order join.

Candidate read-only scan: 27 conversations, **75 messages** (was 71), 24 sent,
one ignored/resolved, two older needs-review, zero current awaiting; no account
errors. Four confirmations restored and three conversations reclassified by
actual later seller-response evidence. No customer messages were sent.

## Explicit limits

The UI now says that only mail delivered to the four configured Amazon inboxes
is covered. Missing email notifications, unconfigured mailboxes, attachments,
and history older than 30 days are not covered. The source recognizes buyer
mail from marketplace.amazon.com and Amazon.com seller-send confirmations;
other regional notification formats require separate evidence and parser work.
Walmart/eBay/TikTok remain Not covered.

No Seller Central/Windows Chrome access was used. Thus no claim is made that a
particular Seller Central-only conversation is absent: a complete comparison
requires an owner-provided export/list of those conversations and notification
mailbox settings, or a separately authorized read-only official source. A missing
notification cannot be reconstructed from email that was never delivered.

The preceding history repair already made All/Sent/Resolved display mail bodies
inside the hub; this follow-up closes a concrete parser gap rather than treating
Awaiting 0 as proof of no conversations.

Validation: six Python parser tests; sidebar component lifecycle check;
changed-file lint; production deployment and mail snapshot checks in topic 42.
Browser navigation tool remains unavailable; no visual production click-through
is claimed. Production alias/assets/API checks are separate evidence.
