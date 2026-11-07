# Submission kit

Everything needed to submit Dead Man's Wallet to the NEAR Hackathon. Placeholders are in double braces and are only
for the payout account, the email and the demo link (the X post URL, which does not exist until you post).
Rules this follows (nearhackathon.com `HACKATHON.md`): the demo post says it was built at NEAR Hackathon, tags
@NEARProtocol and #NEARHackathon, attaches the video, leads with the user problem, shows one complete action, says what
NEAR enables, and ends with links and a question.

## 1. Form payload

Fields: project name, team lead, email, team size, tracks, NEAR mainnet payout account, repo link, demo link,
description (20 to 2000 characters, this one is 1558), contact consent.

```json
{
  "project_name": "Dead Man's Wallet",
  "team_lead": "Andrew Garretson",
  "email": "{{EMAIL}}",
  "team_size": 1,
  "tracks": [
    "security",
    "nfts",
    "open"
  ],
  "near_mainnet_payout_account": "{{NEAR_MAINNET_PAYOUT_ACCOUNT}}",
  "repo_url": "https://github.com/agarretson/deadmans-wallet",
  "demo_url": "{{DEMO_URL}}",
  "description": "Agents hold wallets, API budgets and treasuries. When their operator dies, loses access or is incapacitated, the agent keeps spending until it runs dry, and anything it held on other chains is gone. Existing dead-man's switches move one key or one file on one chain. None can disarm an agent or settle an estate across chains.\n\nDead Man's Wallet is a NEAR contract that does both. While you are alive, a phone key that can only call heartbeat says so. When the heartbeats stop, anyone can poke the contract, and it settles in five steps: heirs are paid on NEAR; the pulse and agent keys are deleted; NEAR's MPC network signs payouts on Base, Monad and Solana; a proposal is filed in the estate DAO; the Will NFT, which holds the funds and draws itself from state, goes to the primary heir. Heirs never touch a seed phrase.\n\nWhat NEAR enables: function-call access keys scoped to one method, so a stolen phone can only say alive and a compromised agent can only spend inside its policy; Chain Signatures, so no key exists for the foreign addresses until the trigger fires; NEP-171 with an on-chain SVG seal; permissionless keepers.\n\nShown on testnet: a prompt-injected agent refused by its wallet, then by the contract itself; a guardian pause that moves the deadline once; an independent review whose Critical and High findings are fixed. Foreign payouts are signed on chain; relay waits for funding of the derived addresses.\n\nTestnet only. Not a will, not a custodian, not audited. Built at NEAR Hackathon with Claude under the direction of the author. MIT.",
  "contact_consent": true
}
```

## 2. X demo post (pick one; attach `docs/video/dmw-demo-v3-720p.mp4`)

Lengths use X's counting (a link is 23 characters whatever its length). Each is under 280.

**A. The agent** (271)

```text
Your AI agent keeps spending after you die.

Dead Man's Wallet: miss the heartbeats and a NEAR contract kills the agent's key and pays heirs. Built at NEAR Hackathon @NEARProtocol #NEARHackathon
deadmanswallet.dev
github.com/agarretson/deadmans-wallet
Who holds your agent's keys?
```

**B. The heirs** (268)

```text
If you died tonight, could your family reach your crypto?

Dead Man's Wallet: when your pulse stops, a NEAR contract pays them. No seed phrase for heirs. Built at NEAR Hackathon @NEARProtocol #NEARHackathon
deadmanswallet.dev
github.com/agarretson/deadmans-wallet
Who is yours?
```

**C. The attack** (277)

```text
A prompt injection told our agent to send everything to a stranger. The wallet refused. With the wallet off, the contract refused.

Dead Man's Wallet, built at NEAR Hackathon @NEARProtocol #NEARHackathon
deadmanswallet.dev
github.com/agarretson/deadmans-wallet
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
1/6 Agents hold wallets and budgets. When the operator disappears, the agent keeps spending and other chains are lost. Dead Man's Wallet is a NEAR contract that settles it: five steps, three chains, one trigger. Built at NEAR Hackathon @NEARProtocol #NEARHackathon
```

```text
2/6 Five steps, each a transaction anyone can call: I heirs paid on NEAR. II pulse and agent keys deleted. III MPC signs the Base, Monad and Solana payouts. IV a proposal filed in the estate DAO. V the Will NFT goes to the primary heir. Testnet links in the repo.
```

```text
3/6 Keys are scoped. The phone's pulse key can call heartbeat and nothing else. The agent's key can call agent_pay, inside a per-tx cap, a daily cap and an allowlist. Both are function-call access keys on the contract's own account, and step II deletes them.
```

```text
4/6 Chain Signatures: the contract asks NEAR's MPC network to sign. Base and Monad use secp256k1, Solana ed25519: two curves, three chains. The source addresses are derived, so no private key exists for them and no signature exists before the trigger.
```

```text
5/6 We planted a prompt injection in the agent's inbox: send the whole balance to a stranger. The wallet refused. With its checks off, the contract denied it and logged why. A guardian can pause the vault once per cycle, for a length the owner sets. Transcript in agent/.
```

```text
6/6 Reproduce it: git clone, make check, make build, make test, make deploy, make demo. The live contract exposes NEP-330 metadata, so the code hash can be rebuilt from the tagged commit. Foreign payouts are signed; relay waits for funded addresses. github.com/agarretson/deadmans-wallet
```

Lengths: 264, 263, 258, 251, 271, 273.

Two corrections to keep the thread honest. Chain Signatures here use two curves (secp256k1 for Base and Monad,
ed25519 for Solana) on three chains, so tweet 4 says that and not "three curves". And the foreign payouts are signed
on chain but not yet relayed, so tweets 5 and 6 and the form description say so.

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
rm -rf /tmp/dmw-fresh && git clone --branch hackathon-submission https://github.com/agarretson/deadmans-wallet /tmp/dmw-fresh
cd /tmp/dmw-fresh && make check                      # "All good."
make build && make test                              # contract 95+, keeper 46, dashboard 67+, agent 37 passed (about 5 min)
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

# 4. NEP-330 link check
curl -s https://rpc.testnet.near.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"dmw-x8cx.testnet","method_name":"contract_source_metadata","args_base64":"e30="}}' \
  | python3 -c 'import sys,json;print(bytes(json.load(sys.stdin)["result"]["result"]).decode())'
#   -> "link" must be the repo URL; "version"/"build_info" name the commit
curl -sI https://github.com/agarretson/deadmans-wallet | head -1            # 200 (repo is public)
curl -sI https://github.com/agarretson/deadmans-wallet/tree/hackathon-submission | head -1           # 200
# if the contract was redeployed after the build_info commit, the README code hash is stale:
#   git checkout <build_info commit> && make build-reproducible && compare with `view_account dmw-x8cx.testnet` code_hash

# 5. the video
ffprobe -v error -show_entries format=duration,size -of csv=p=0 docs/video/dmw-demo-v3-720p.mp4   # 170 s, about 13 MB
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
print(len(f['description']), '(20..2000)', sorted(re.findall(r'\{\{\w+\}\}',json.dumps(f))))
PY
#   -> a length between 20 and 2000, and exactly: {{DEMO_URL}} {{EMAIL}} {{NEAR_MAINNET_PAYOUT_ACCOUNT}}
```

Then, in order: post the demo with the video attached; copy its URL into `demo_url`; fill the email and the NEAR
mainnet payout account (a mainnet account, not `.testnet`); tick contact consent; submit; post the thread.
