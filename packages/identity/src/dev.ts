import { createHmac, timingSafeEqual } from "node:crypto";
import { AuthRequired, type Access, type Operator, type OperatorIdentity } from "./operator-identity.js";

export interface DevOperator extends Operator {
  admin: boolean;
}

export class DevIdentityRefused extends Error {
  constructor() {
    super("the development identity is not allowed in the prod stage");
    this.name = "DevIdentityRefused";
  }
}

/**
 * Development-only operator identity: a fixed operator list and HMAC-signed tokens.
 * Refuses to exist in `prod` (plan Complexity Tracking), until Rovara's sign-in for services lands.
 */
export class DevIdentity implements OperatorIdentity {
  private readonly byId: Map<string, DevOperator>;

  constructor(
    private readonly opts: { stage: string; operators: DevOperator[]; signingKey: string },
  ) {
    if (opts.stage === "prod") throw new DevIdentityRefused();
    this.byId = new Map(opts.operators.map((o) => [o.id, o]));
  }

  private mac(id: string): string {
    return createHmac("sha256", this.opts.signingKey).update(`dev-operator:${id}`).digest("base64url");
  }

  async login(username: string): Promise<{ token: string; operator: Operator }> {
    const op = this.byId.get(username);
    if (!op) throw new AuthRequired(`${username} is not an operator`);
    return { token: `dev.${op.id}.${this.mac(op.id)}`, operator: { id: op.id, name: op.name } };
  }

  async verify(token: string | undefined): Promise<Operator> {
    const m = token ? /^dev\.([^.]+)\.([A-Za-z0-9_-]+)$/.exec(token) : null;
    if (!m) throw new AuthRequired();
    const [, id, mac] = m;
    const expected = Buffer.from(this.mac(id!));
    const given = Buffer.from(mac!);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new AuthRequired("the token is not valid");
    const op = this.byId.get(id!);
    if (!op) throw new AuthRequired("the token's operator is no longer configured");
    return { id: op.id, name: op.name };
  }

  async access(operator: Operator): Promise<Access> {
    const op = this.byId.get(operator.id);
    return { isOperator: !!op, isAdmin: !!op?.admin };
  }
}
