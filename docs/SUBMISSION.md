# Submission kit

Everything needed to submit Dead Man's Wallet to the NEAR Hackathon. Placeholders are in double braces and are only
for the request id (a fresh lowercase UUID: `node -e 'console.log(crypto.randomUUID())'`, reused on retries), the payout
account, the email, the demo link (`{{X_POST_URL}}`: the X post URL, which does not exist until you post) and, in the X posts, the site
URL. `deadmanswallet.dev` did not resolve on Nov 7 2026 (NXDOMAIN), so `{{SITE_URL}}` must be the deployed Vercel site
until that domain is registered.
Rules this follows (nearhackathon.com `HACKATHON.md`): the demo post says it was built at NEAR Hackathon, tags
@NEARProtocol and #NEARHackathon, attaches the video, leads with the user problem, shows one complete action, says what
NEAR enables, and ends with links and a question.

## 1. Form payload

`POST https://nearhackathon.com/api/applications` takes exactly these keys and no others (no `website` key: it is a
spam trap): `requestId`, `projectName`, `leadName`, `email`, `size`, `tracks`, `nearAddress` (lowercase mainnet
account), `projectUrl` (the public repo), `demoUrl` (the public X post), `idea` (20 to 2000 characters, this one is
1871), `consent` (`true` only after the human agrees to the contact notice). The repo must be public by the deadline
(2026-11-14 23:59 UTC): on Nov 10 2026 `github.com/bigbenny1231/will-wallet` was still private (404 to an anonymous
client). Make it public only after the fixed contract is deployed (`docs/FINAL_REVIEW.md`, step 1).

```json
{
  "requestId": "{{REQUEST_ID}}",
  "projectName": "Dead Man's Wallet",
  "leadName": "Andrew Garretson",
  "email": "{{EMAIL}}",
  "size": "1",
  "tracks": [
    "security",
    "nfts",
    "open"
  ],
  "nearAddress": "{{NEAR_MAINNET_PAYOUT_ACCOUNT}}",
  "projectUrl": "https://github.com/bigbenny1231/will-wallet",
  "demoUrl": "{{X_POST_URL}}",
  "idea": "Agents hold wallets, API budgets and treasuries. When their operator dies, loses access or is incapacitated, the agent keeps spending until it runs dry, and anything it held on other chains is gone. The dead-man's switches we found move one key or one file on one chain; none disarms an agent or settles an estate across chains.\n\nDead Man's Wallet is a NEAR contract that does both. While you are alive, a phone key that can only call heartbeat says so. When the heartbeats stop, anyone can poke the contract, and it settles in five steps: heirs are paid on NEAR, with nothing for them to sign; the pulse and agent keys are deleted; NEAR's MPC network signs payouts on Base, Monad and Solana; a proposal is filed in the estate DAO; the Will NFT, which draws itself from state and can claim what is left, goes to the primary heir.\n\nWhat NEAR enables: function-call access keys scoped to one method, so a stolen phone can only say alive and a compromised agent can only spend inside its policy; Chain Signatures, so no single party holds a key for the foreign addresses and the contract requests signatures only after the trigger; NEP-171 with an on-chain SVG seal; permissionless keepers.\n\nTry it with no wallet: the dashboard makes a throwaway testnet account in your browser and runs a whole estate, from first heartbeat to the heir's claim, in three minutes.\n\nShown on testnet: an agent scripted to obey a planted prompt injection, refused by its wallet, then by the contract itself; a guardian pause that moves the deadline once; three review rounds by separate AI agents, with every Critical and High finding fixed. Foreign payouts are signed on chain but none has been relayed: the derived addresses are unfunded.\n\nTestnet only. Not a will, not a custodian, not audited. Built at NEAR Hackathon, mostly AI-generated with Claude under the direction of the author. MIT.",
  "consent": true
}
```

## 2. X demo post (pick one; attach `site/assets/demo-720p.mp4`, the corrected 2:50 cut)

Do not attach the older `docs/video/dmw-demo-v3-720p.mp4` master: it is not in the repo and its end card prints the old
repository address.

Lengths use X's counting (a link is 23 characters whatever its length). Each is under 280.

**A. The agent** (271)

```text
Your AI agent keeps spending after you die.

Dead Man's Wallet: miss the heartbeats and a NEAR contract kills the agent's key and pays heirs. Built at NEAR Hackathon @NEARProtocol #NEARHackathon
{{SITE_URL}}
github.com/bigbenny1231/will-wallet
Who holds your agent's keys?
```

**B. The heirs** (253)

```text
Your crypto shouldn't die with you.

Dead Man's Wallet: when your pulse stops, a NEAR contract pays them. They sign nothing to receive it. Built at NEAR Hackathon @NEARProtocol #NEARHackathon
{{SITE_URL}}
github.com/bigbenny1231/will-wallet
Who is yours?
```

**C. The attack** (277)

```text
Our scripted agent obeyed a prompt injection: send everything to a stranger. The wallet refused. Wallet off: the contract refused.

Dead Man's Wallet, built at NEAR Hackathon @NEARProtocol #NEARHackathon
{{SITE_URL}}
github.com/bigbenny1231/will-wallet
What would you test next?
```

Each one shows the complete action in the video: a vault that is Alive, a stopped pulse, and five settlement steps to
Settled. Variant A is the agent story (the Security track), B the heir story (the NFT and Open tracks), C the attack.
The video is 2:50. X accepts 2:20 on a standard account and 10 minutes on Premium, so check the posting account first
(item 4 of the checklist).

## 3. Thread, days 1 to 3 (technical)

Post the demo post first. Reply the thread under it, one tweet a day or all at once. No tweet has an attachment except
tweet 2 (use `docs/diagrams/settlement-sequence.png`) and tweet 5 (a crop of `docs/video/stills-v3/03-agent-refused.png`).


```text
1/6 Agents hold wallets and budgets. When the operator disappears, the agent keeps spending and other chains are lost. Dead Man's Wallet is a NEAR contract that settles it: five steps, one trigger. Built at NEAR Hackathon @NEARProtocol #NEARHackathon
```

```text
2/6 Five steps, each a transaction anyone can call: I heirs paid on NEAR. II pulse and agent keys deleted. III MPC signs the Base, Monad and Solana payouts. IV a proposal filed in the estate DAO. V the Will NFT goes to the primary heir. Testnet links in the repo.
```

```text
3/6 Keys are scoped. The phone's pulse key can call heartbeat and nothing else. The agent's key can call agent_pay, inside a per-tx cap, a daily cap and an allowlist. Both are function-call access keys on the contract's own account, and step II deletes them.
```

```text
4/6 Chain Signatures: the contract asks NEAR's MPC network to sign. Base and Monad use secp256k1, Solana ed25519: two curves, three chains. The source addresses are derived: no one holds their private key, and the contract asks for signatures only after the trigger.
```

```text
5/6 We planted a prompt injection (send the whole balance to a stranger) and scripted the agent to obey. The wallet refused. With its checks off, the contract denied it and logged why. A guardian can pause the vault once per cycle, for a length the owner sets.
```

```text
6/6 Reproduce it: git clone, make check, make build, make test, make deploy, make demo. make build matches the live code hash with the same toolchain (rustc 1.97, cargo-near 0.23). Foreign payouts are signed; relay waits for funded addresses. github.com/bigbenny1231/will-wallet
```

Lengths: 250, 263, 258, 266, 260, 266.

What keeps the thread honest (see `docs/AUDIT_CLAIMS.md`). Chain Signatures here use two curves (secp256k1 for Base
and Monad, ed25519 for Solana) on three chains, so tweet 4 says that and not "three curves". The foreign payouts are
signed on chain but not yet relayed, so tweet 6 and the form description say so. The recorded agent runs use the
scripted brain, written to obey the injection, so post C and tweet 5 say "scripted". The live contract is not a
reproducible build (`build_info` is null), so tweet 6 claims only a same-toolchain hash match. Heirs need a NEAR account
named in the plan; they sign nothing to receive NEAR, which is what post B and the description claim, not "no seed
phrase". The video's end card still shows the line "No seed phrase for your heirs." (burned in; see
`docs/video/VOICEOVER.md`): heirs do need a NEAR account named in the plan.

## 4. Pre-submit checklist

Run each command; every one should print what the comment says. `SITE` and `DASH` are your two Vercel production URLs.

```bash
# 0. state of the tree
cd deadmans-wallet && git status --short            # empty
git log --oneline | head -3

# 1. tag the submitted tree, push it
git tag -a hackathon-submission -m "NEAR Hackathon submission"
git push origin master hackathon-submission
git ls-remote --tags origin hackathon-submission    # one line

# 2. fresh clone of the tag
rm -rf /tmp/dmw-fresh && git clone --branch hackathon-submission https://github.com/bigbenny1231/will-wallet /tmp/dmw-fresh
cd /tmp/dmw-fresh && make check                      # "All good."
make build && make test                              # contract 105, keeper 90, dashboard 99, agent 61 passed (about 3 min)
cd -

# 3. Vercel (set the two URLs first)
SITE=https://<site>.vercel.app ; DASH=https://<dashboard>.vercel.app
curl -sI $SITE | head -1                             # HTTP/2 200
curl -s  $SITE | grep -o 'og:image" content="[^"]*"' # .../assets/og.png
curl -sI $SITE/assets/og.png | grep -i 'HTTP\|content-type'   # 200, image/png
curl -sI $DASH | head -1                             # 200
curl -sI $DASH/vault/6 | head -1                     # 200 (SPA rewrite)
curl -sI $DASH/pulse | head -1                       # 200
curl -sI $SITE/assets/demo-720p.mp4 | head -1        # 200 only if the mp4 was in the deployed folder (site/README.md); it must be the v3 cut
ffprobe -v error -show_entries format=duration -of csv=p=0 site/assets/demo-720p.mp4   # 170.458333 (v3, end card corrected Nov 9, 3.2 MB). The file is committed; do not overwrite it with the older docs/video master

# 4. NEP-330 link check
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"dmw-x8cx.testnet","method_name":"contract_source_metadata","args_base64":"e30="}}' \
  | python3 -c 'import sys,json;print(bytes(json.load(sys.stdin)["result"]["result"]).decode())'
#   -> "link" must be the repo URL. "build_info" is null: the live code comes from `cargo near build
#      non-reproducible-wasm`, so only a same-toolchain `make build` matches it. The expected hash is in the README row
#      "The live contract is this source" and in docs/FINAL_REVIEW.md
curl -sI https://github.com/bigbenny1231/will-wallet | head -1            # 200 (repo is public)
curl -sI https://github.com/bigbenny1231/will-wallet/tree/hackathon-submission | head -1           # 200
# compare: `make build` (rustc 1.97.0, cargo-near 0.23.0) prints the code hash; `view_account dmw-x8cx.testnet` code_hash
# must be the same. If the contract is redeployed, update the README row "The live contract is this source".

# 5. the video
ffprobe -v error -show_entries format=duration,size -of csv=p=0 site/assets/demo-720p.mp4   # 170.458333,3199135 (2:50, 3.2 MB)
#   2:50 is over X's 2:20 limit for a standard account: post from a Premium account, or cut to 2:20 first

# 6. the showcase vault (nothing is relayed until its addresses hold funds)
cd keeper && npm run derive -- --token 6             # Base 0x2cC6...28f4, Monad 0x07BF...ba5b, Solana 5iue...zvzc
cd .. && make status TOKEN=6                         # vault 6 Alive, three payouts pending
# fund: Base >= 0.001 ETH, Monad >= 0.05 MON (10 MON reserve: the single payout is an emptying tx), Solana >= 0.05 SOL
# (faucets in keeper/SHOWCASE.md)

# 7. before you press submit
python3 - <<'PY'
import json,re
t=open('docs/SUBMISSION.md').read()
f=json.loads(re.search(r'```json\n(.*?)\n```',t,re.S).group(1))
assert set(f)=={'requestId','projectName','leadName','email','size','tracks','nearAddress','projectUrl','demoUrl','idea','consent'}
print(len(f['idea']), '(20..2000)', sorted(re.findall(r'\{\{\w+\}\}',json.dumps(f))))
PY
#   -> a length between 20 and 2000, and exactly: {{EMAIL}} {{NEAR_MAINNET_PAYOUT_ACCOUNT}} {{REQUEST_ID}} {{X_POST_URL}}
```

Then, in order: deploy the fixed contract and merge the fix branch (`docs/FINAL_REVIEW.md`); make the repo public;
tag and push `hackathon-submission` (steps 1 and 2 above need the public repo and the tag); post the demo with the video attached (replace `{{SITE_URL}}` with the live
site); copy its URL into `demoUrl`; fill `requestId`, the email and `nearAddress` (a lowercase mainnet account, not
`.testnet`); set `consent` only after the human agrees; submit; post the thread.
