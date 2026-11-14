/**
 * Mint a development-identity token for one operator of a TEST or load deployment (until
 * Rovara#442). The token is signed with the stage's Rovara adapter secret, read from the secret
 * store, so only someone who can read that secret can mint one.
 *
 *   npx tsx scripts/dev-token.ts --stage test --operator dev_alice
 *   rovara-orch login --token <printed token>
 */
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DevIdentity } from "@rovara-orch/identity";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`--${name} is required`);
  return v;
};
const stage = arg("stage");
const operator = arg("operator");
if (stage === "prod") throw new Error("the development identity is not allowed in prod");
const sm = new SecretsManagerClient({});
const secret = (await sm.send(new GetSecretValueCommand({ SecretId: `rovara-orch/${stage}/rovara-adapter-secret` }))).SecretString!;
const identity = new DevIdentity({ stage, operators: [{ id: operator, name: operator, admin: false }], signingKey: secret });
console.log((await identity.login(operator)).token);
