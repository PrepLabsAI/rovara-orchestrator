/**
 * Who an operator is. Operators sign in with Rovara (FR-054); this interface hides how, so the
 * development-only identity can be replaced by the Rovara one once PrepLabsAI/Rovara#442 lands.
 */
export interface Operator {
  /** The operator's Rovara developer id. */
  id: string;
  name: string;
}

export interface Access {
  /** A Rovara administrator, or a person with access to the monorepo's Rovara project. */
  isOperator: boolean;
  isAdmin: boolean;
}

export class AuthRequired extends Error {
  constructor(message = "sign in with Rovara first: rovara-orch login") {
    super(message);
    this.name = "AuthRequired";
  }
}

export interface OperatorIdentity {
  /** Check a bearer token addressed to the orchestrator; throws AuthRequired. */
  verify(token: string | undefined): Promise<Operator>;
  /** Ask, on every action, whether the person is still an operator. */
  access(operator: Operator): Promise<Access>;
  /** For the CLI's `login`: exchange credentials for a token (development identity only). */
  login?(username: string): Promise<{ token: string; operator: Operator }>;
}
