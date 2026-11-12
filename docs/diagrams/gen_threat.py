import textwrap, html
rows=[
("Thief with the phone","holds the pulse key",
 ["send heartbeat, 10 TGas, up to 1 NEAR of allowance","keep the vault Alive while the key lives"],
 ["move funds or change the plan","add keys or call agent_pay","act on any other contract"],
 ["function-call key scoped to heartbeat","owner removes it with remove_key","owner change revokes every key (H-3)","residual: delays settlement until removed"]),
("Compromised agent","holds the agent key",
 ["agent_pay inside per-tx cap, daily cap and allowlist, while Alive"],
 ["exceed policy or pay the contract itself (L-5)","pay once a beat is missed","heartbeat, or change the plan"],
 ["denials return a reason and are logged","agent is disarmed at Warning","key deleted in step II","residual: spend up to the daily cap"]),
("Malicious keeper","runs the keeper CLI",
 ["choose when to poke and step","relay late, or not at all","front-run step III with poor chain params (M-2)"],
 ["pick destination, amount or chain","pick the EVM nonce (C-1) or exceed fee and gas caps (H-2)","record a fake broadcast hash (H-1)"],
 ["contract builds the tx; nonce is pinned","gas 21000 to 100000, fee at most 100 gwei","hash recomputed from stored tx","anyone can relay; re-sign after cooldown"]),
("NFT buyer","buys the Will NFT",
 ["edit the plan, as owner, while Alive or Warning","claim the remainder once Settled"],
 ["use the seller's pulse or agent keys","act after Triggered","transfer the NFT after Triggered"],
 ["owner change revokes every key (H-3)","a key whose AddKey lands late is deleted","heirs should re-check the plan after a transfer"]),
("Anyone","no key, no role",
 ["poke after the deadline, earn the bounty","execute_step, relay, mark_broadcast with the right hash","deposit"],
 ["poke early (it panics not_due)","change heirs, amounts or destinations","block settlement, or obtain a second signature for a payout (C-1)"],
 ["permissionless on purpose","one re-sign in flight per payout","residual: deposit spam can flush the 40-entry log (L-3)"]),
]
cols=[(30,170),(222,246),(482,246),(742,228)]
def wrap(t,w): return textwrap.wrap(t,int(w/6.55))
out=[];y=150
out.append(f'<text x="222" y="126" class="lab" style="fill:#F5B942">CAN</text><text x="482" y="126" class="lab" style="fill:#3DDC84">CANNOT</text><text x="742" y="126" class="lab">WHAT STOPS IT</text><text x="30" y="126" class="lab">ATTACKER</text>')
out.append(f'<line x1="30" y1="138" x2="970" y2="138" stroke="#C8A96A" stroke-width="1"/>')
LH=18
for name,role,can,cannot,mit in rows:
    cells=[]
    for items,(x,w) in zip((can,cannot,mit),cols[1:]):
        ls=[]
        for it in items:
            wl=wrap(it,w-16)
            for i,l in enumerate(wl): ls.append((i==0,l))
        cells.append((x,ls))
    n=max(len(c[1]) for c in cells)
    h=max(n*LH+26,84)
    out.append(f'<text x="30" y="{y+30}" class="h">{html.escape(name)}</text><text x="30" y="{y+52}" class="m mb" style="font-size:12.5px">{html.escape(role)}</text>')
    for x,ls in cells:
        for i,(first,l) in enumerate(ls):
            yy=y+28+i*LH
            if first: out.append(f'<circle cx="{x+3}" cy="{yy-4}" r="2" fill="#8C7446"/>')
            out.append(f'<text x="{x+16}" y="{yy}" class="sm" style="fill:#EDE7DC">{html.escape(l)}</text>')
    y+=h
    out.append(f'<line x1="30" y1="{y}" x2="970" y2="{y}" class="hair"/>')
    y+=12
y+=10
out.append(f'<rect x="30" y="{y}" width="940" height="74" class="panel" rx="4"/><rect x="30" y="{y}" width="3" height="74" fill="#3DDC84"/>')
out.append(f'<text x="50" y="{y+28}" class="lab" style="fill:#3DDC84">NO FULL-ACCESS KEY</text>')
out.append(f'<text x="50" y="{y+50}" class="b" style="font-size:14.5px">The contract account has no full-access key, so nobody, its authors included, can deploy new code or move a vault outside the rules.</text>')
out.append(f'<text x="50" y="{y+67}" class="sm" style="font-size:13px">A Solana payout that is already signed can be re-signed only by a keeper (M-3, F1).</text>')
y+=74+40
H=int(y+30)
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 {H}" width="1000" height="{H}" role="img" aria-labelledby="t d">
<title id="t">Threat model</title>
<desc id="d">Five attackers, what each can and cannot do, and the mitigations from the security review, and the contract account, which has no full-access key.</desc>
<style>/*STYLE*/</style>
<rect width="1000" height="{H}" fill="#0B0C0F"/>
<text x="30" y="58" class="title">Threat model, <tspan class="it">by who holds what</tspan></text>
<text x="30" y="84" class="b2">Ids refer to findings in docs/SECURITY_REVIEW.md. Every Critical and High item is fixed with a regression test.</text>
<line x1="30" y1="100" x2="970" y2="100" class="hair"/>
{chr(10).join(out)}
<text x="30" y="{H-14}" class="sm">Each key is a NEAR function-call access key on the contract's own account, scoped to one method.</text>
</svg>
'''
open('src/threat-model.svg','w').write(svg)
