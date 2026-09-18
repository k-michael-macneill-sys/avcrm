/**
 * What every outbound channel has in common, kept apart from any of them.
 *
 * Mail and SMS both need to tell the queue two things — the provider's id for
 * what was sent, or that it failed and whether trying again could help. Those
 * live here rather than in either transport so neither has to import the
 * other.
 */

export interface SendResult {
  /** The provider's id for the message, recorded against the log row. */
  provider_message_id: string;
}

/**
 * A send that did not work, and whether trying again could help.
 *
 * The distinction matters: a permanent refusal means the address or number is
 * wrong, and hammering it three more times wastes the attempt budget and looks
 * like abuse to whoever is refusing it. A temporary one — a greylist, a
 * rate limit, a gateway having a bad afternoon — is exactly what retries are
 * for.
 */
export class SendFailure extends Error {
  readonly permanent: boolean;
  readonly code: string | undefined;

  constructor(message: string, permanent: boolean, code?: string) {
    super(message);
    this.name = 'SendFailure';
    this.permanent = permanent;
    this.code = code;
  }
}
