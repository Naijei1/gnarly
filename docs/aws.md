# Gnarly on AWS

The publish API can run on the account that already holds the data. This change does not deploy, does not create Cognito users, and does not touch DNS, Firebase, or the naijei.com host.

## What is already there

Account `402275401617`, region `us-east-1`, tagged `project=gnarly`.

| Resource | Name |
| --- | --- |
| DynamoDB table | `gnarly` (index `GSI1`) |
| S3 bucket | `gnarly-data-402275401617-us-east-1` |
| Cognito user pool | `us-east-1_pQIUmVbPJ` |
| Cognito app client | `1osnrt38iuqvf5laum1tnj1hdn` (public, SRP + refresh, email sign-in, self-signup off) |

Object keys are unchanged from Firebase Storage: `buildings/<id>/<version>/...`. Some keys contain spaces. The bucket CORS allows `https://naijei.com` and `http://localhost:5173`. This change does not edit that CORS configuration. Browser uploads use presigned PUTs, so the rule also needs `PUT` and the `Content-Type` request header. Confirm that before relying on in-browser saves; downloads only need `GET`.

DynamoDB items:

- Building: `PK=BUILDING#<id>`, `SK=META`, `GSI1PK=BUILDINGS`, `GSI1SK=BUILDING#<id>`
- Version: `SK=VERSION#<versionId>`
- Zone: `SK=ZONE#<versionId>#<zoneId>`
- Floor: `SK=FLOOR#<versionId>#<floorId>`
- Publish: `SK=PUBLISH#<publishId>`, with the session stored on `record`
- Rate counter: `PK=RATE#<key>`, `SK=RATE`, numeric `ttl` (epoch seconds)

Items carry `type`, `buildingId`, `versionId`, `ownerUid` (null on imported rows), `legacyOwnerUid`, and `acl` (an empty map on imported rows). Some buildings set `metadataOnly`.

## Access rule

Everyone, including anonymous visitors, can list buildings and download published files. The site and API are otherwise read-only.

Writes (create, publish, commit, presigned PUT, graph/layout/connection pointer updates, record edits) succeed only when the bearer token has `email_verified: true` and `email` is in `ADMIN_EMAILS`. The default is `nj277@cornell.edu`. The comparison is case-insensitive. A signed-in user with any other email gets HTTP 403. A missing token on a write gets HTTP 401.

The web app hides the Edit tab, the cloud save mode, and record-editing controls unless that same verified email is signed in. Hiding the controls is not the security check; the API is.

On AWS the token must be a Cognito **ID** token (the access token has no email claim). The web client uses SRP and sends the ID token.

## Environment

API (`api/.env.example`):

```sh
GNARLY_BACKEND=aws
AWS_REGION=us-east-1
GNARLY_TABLE=gnarly
GNARLY_BUCKET=gnarly-data-402275401617-us-east-1
COGNITO_USER_POOL_ID=us-east-1_pQIUmVbPJ
COGNITO_CLIENT_ID=1osnrt38iuqvf5laum1tnj1hdn
ADMIN_EMAILS=nj277@cornell.edu
GNARLY_CORS_ORIGINS=https://naijei.com,http://localhost:5173,http://localhost:4173
```

`GNARLY_BACKEND=firebase` (the default when unset) keeps the Firebase backend.

Web (`web/.env.example`):

```sh
VITE_GNARLY_API_BASE=https://<function-url>
VITE_COGNITO_USER_POOL_ID=us-east-1_pQIUmVbPJ
VITE_COGNITO_CLIENT_ID=1osnrt38iuqvf5laum1tnj1hdn
VITE_ADMIN_EMAILS=nj277@cornell.edu
VITE_BASE=/gnarly/
```

`VITE_BASE=/gnarly/` is for a build served at `https://naijei.com/gnarly/`. Local `npm run dev` should leave `VITE_BASE=/`.

## Deploy the API (not done here)

From a machine whose credentials can deploy in this account. The stack imports the table and bucket; it does not create or delete them.

```sh
cd infra
npm install
npm run bundle    # compiles api/ and installs the Lambda runtime deps into infra/build
npx cdk synth
npx cdk diff
npx cdk deploy    # only when you intend to publish the API
```

The stack `GnarlyApi` is tagged `project=gnarly`. Its Lambda role can:

- `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `Query`, `ConditionCheckItem`, `DescribeTable` on `gnarly` and `gnarly/index/GSI1`
- `s3:GetObject`, `PutObject`, `AbortMultipartUpload` on the bucket's objects
- `s3:ListBucket` on prefix `buildings/*` so a missing object is a 404 rather than a 403

It cannot delete objects or items. The Function URL is public (`authType: NONE`); the function checks the JWT itself. CORS is handled by the function for `https://naijei.com` and localhost. Copy the `ApiUrl` output into `VITE_GNARLY_API_BASE`.

Do not point naijei.com DNS at the Function URL from this stack. Hosting the web build at `/gnarly/` is a separate step and was not changed.

Local API, without Lambda:

```sh
cd api && npm install && npm test
set -a && source .env && set +a
npm start
```

## Cognito sign-in was not finished

Self-signup is off, and this change does not call `SignUp` or `AdminCreateUser`. Email/password SRP works only if `nj277@cornell.edu` already exists in the pool with a permanent password.

If that person can only sign in with Google today, the pool needs a Google IdP (or a hosted UI) before the web form can use it. That federation was **not** configured. A temporary Cognito password also cannot be completed in the form; set a permanent password in the pool, then sign in.

## Other clients

The mapper and Navigator still obtain Firebase ID tokens. Against this API:

- downloads work with no token
- publish and other writes need a Cognito ID token for `nj277@cornell.edu`

Those apps were not switched to Cognito.

## Checks

```sh
cd api && npm test
cd web && npx tsc -p tsconfig.json --noEmit && npm test
```

`api/test/auth.test.ts` covers anonymous reads and the verified-email write rule. `api/test/dynamo.test.ts` covers the single-table keys, the conditional commit, pointer conflicts, and rate-counter `ttl`.
