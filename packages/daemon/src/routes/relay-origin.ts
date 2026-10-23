import { RELAY_HEADER, IDENTITY_PROVENANCE_HEADER, type IdentityProvenance } from "./require-sender-identity.js";
import { isHumanSeatSessionRef } from "../domain/session-name.js";

/**
 * The ONE place a forwarding daemon records WHERE a relayed queue write
 * was issued from.
 *
 * The problem this closes: `resolve` derives its actor from the seat environment of the daemon it
 * runs against, so answering a team's parked qitem from the hub either failed outright (a human at
 * a plain terminal has no seat env) or was done inside the team's pod as the team's lead session —
 * which records a seat as the resolver when in fact a human answered. The cross-host forward already
 * carried the hub's own host id in {@link RELAY_HEADER}, but the receiving side read it only as a
 * boolean "relayed" flag and dropped the value, so the row could never say which machine answered.
 *
 * TRUST, stated honestly: the stamp is composed by the FORWARDING HUB from its own durable self-host
 * id, and it is BEARER-TRUSTED AT THE ORIGIN — the team accepts it because it accepts the hub's
 * bearer, exactly as it accepts `X-OpenRig-Relay`. What it is NOT is a proof the hub could not lie
 * about. What these helpers guarantee is narrower and still worth having: a caller cannot choose
 * which host its write claims to have come from, because every path that could carry the key either
 * has the hub's stamp written over it, has the claim stripped, or — on a relayed arrival — is kept only
 * when it names the very host the relay header names.
 *
 * SWAP NOTE: if the TEAM's daemon is later made to record the relay origin itself, only
 * {@link relayOriginAuditNotes} and {@link relayForwardHeaders} change — the
 * receiving route would read {@link RELAY_HEADER} and require `from_host` to match it. No call site
 * changes shape.
 */

/** The audit-notes key the stamp lands under. Namespaced so it can never collide with a caller's own
 *  audit notes, and so a reader can tell the hub's stamp from a stray claim at a glance. */
export const RELAY_AUDIT_KEY = "openrig_relay";

export interface RelayOrigin {
  /** The forwarding daemon's own host id — composed by the hub, bearer-trusted at the origin. */
  from_host: string;
}

/** The forwarding daemon's self-host id as a stamp, or null when its identity is unavailable.
 *  Absence is honest: an unprovable origin is recorded as absent, never guessed. */
export function relayOriginOf(selfHostId: string | null | undefined): RelayOrigin | null {
  const host = selfHostId?.trim();
  return host ? { from_host: host } : null;
}

/**
 * Merge the hub's stamp into the audit notes a forwarded write carries. Any caller-supplied value
 * under {@link RELAY_AUDIT_KEY} is DROPPED and replaced, so a client that sent
 * `auditNotes.openrig_relay.from_host = "somewhere-flattering"` still records the host the request
 * actually left from. Returns null (NOT the caller's object) when nothing is left to record —
 * returning the caller's object there would forward the very claim the strip exists to remove.
 */
export function relayOriginAuditNotes(
  callerAuditNotes: Record<string, unknown> | null | undefined,
  selfHostId: string | null | undefined,
): Record<string, unknown> | null {
  const { [RELAY_AUDIT_KEY]: _dropped, ...rest } = callerAuditNotes ?? {};
  const stamp = relayOriginOf(selfHostId);
  if (!stamp) return Object.keys(rest).length ? rest : null;
  return { ...rest, [RELAY_AUDIT_KEY]: stamp };
}

/**
 * On a path that is NOT a verified relay hop, a caller-supplied relay key is a claim with no hub stamp
 * behind it. Strip it, so a local write can never store something that reads like the hub's stamp.
 * On a relayed arrival the key is kept ONLY when it names the same host the relay header names —
 * otherwise anyone who can set `X-OpenRig-Relay` could park any `from_host` they liked on the row.
 * Absent input stays absent: a write with no audit notes must not gain one.
 */
export function stripRelayClaim(
  callerAuditNotes: Record<string, unknown> | null | undefined,
  relayedFrom: string | null | undefined,
): Record<string, unknown> | null | undefined {
  if (!callerAuditNotes) return callerAuditNotes;
  const stamp = callerAuditNotes[RELAY_AUDIT_KEY];
  const claimed = stamp && typeof stamp === "object" && !Array.isArray(stamp)
    ? String((stamp as Record<string, unknown>).from_host ?? "")
    : "";
  const relay = relayedFrom?.trim() ?? "";
  if (relay && claimed === relay) return callerAuditNotes;
  const { [RELAY_AUDIT_KEY]: _dropped, ...rest } = callerAuditNotes;
  return Object.keys(rest).length ? rest : null;
}

/**
 * The actor a relayed write carries onward. A bare `member@rig` names a seat ON THE HOST THAT READS
 * IT, so forwarding a hub seat unqualified would record a hub seat as one of the team's own seats —
 * the same misattribution this increment exists to remove. A FOREIGN host qualifier is the shipped
 * "came from that host" spelling (`senderIdentityHeaders` produces it; `canonicalSenderSession`
 * preserves it verbatim), so a non-human actor is re-qualified with the forwarding hub's id.
 * Human-seat refs are left alone: `human@host` / `human@kernel` are host-independent by contract,
 * and a 3-part ref is not human-CLASS, so qualifying one would move it out of the class that makes
 * it truthful.
 */
export function relayActorOf(session: string, selfHostId: string | null | undefined): string {
  if (isHumanSeatSessionRef(session)) return session;
  const host = selfHostId?.trim();
  if (!host) return session;
  const parts = session.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return session;
  return `${session}@${host}`;
}

/**
 * The identity headers a forwarding daemon stamps on a relayed queue write, mirroring the shipped
 * mission-control forward: the actor is RE-DERIVED from this daemon's own authenticated context (the
 * inbound body claim is stripped by the caller, so it can never ride through), the relay marker names
 * this host, and the provenance marker carries what THIS hop proved so the origin can only degrade it.
 */
export function relayForwardHeaders(
  identity: { session: string; provenance: Exclude<IdentityProvenance, "relay:v1"> },
  selfHostId: string | null,
): Record<string, string> {
  return {
    "X-OpenRig-Session": relayActorOf(identity.session, selfHostId),
    [RELAY_HEADER]: selfHostId ?? "unknown",
    [IDENTITY_PROVENANCE_HEADER]: identity.provenance,
  };
}
