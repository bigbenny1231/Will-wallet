# Generates src/settlement-sequence.svg
X={'k':105,'d':320,'o':525,'s':725,'c':905}
names=[('k','Keeper','off-chain CLI'),('d','dmw contract','dmw-x8cx.testnet'),('o','omni-transaction','in-contract lib'),('s','v1.signer','MPC network'),('c','Foreign chain','Base Sol Monad')]
out=[];y=0
def bgtext(x,yy,txt,cls,anchor='middle',w=None):
    est=w or len(txt)*(7.9 if 'm' in cls.split() else 6.7)
    x0=x-est/2-4 if anchor=='middle' else x-4
    out.append(f'<rect x="{x0:.0f}" y="{yy-13}" width="{est+8:.0f}" height="18" fill="#0B0C0F"/>')
    out.append(f'<text x="{x}" y="{yy}" text-anchor="{anchor}" class="{cls}">{txt}</text>')
def msg(n,a,b,label,sub,dashed=False,ys=None):
    global y
    x1,x2=X[a],X[b]; mid=(x1+x2)/2
    col='#A9A399' if dashed else '#C8A96A'
    d=' stroke-dasharray="5 4"' if dashed else ''
    head=f'M{x1} {y} H{x2-(0)}'
    out.append(f'<path d="M{x1} {y} H{x2}" stroke="{col}" stroke-width="1.5" fill="none"{d} marker-end="url(#{"ahg" if dashed else "ah"})"/>')
    bgtext(mid,y-8,f'<tspan class="mb" style="fill:#8C7446">{n}</tspan>  <tspan style="fill:{"#A9A399" if dashed else "#C8A96A"}">{label}</tspan>','m',w=len(label)*7.9+30)
    for i,s in enumerate(sub):
        bgtext(mid,y+18+17*i,s,'sm')
    y+=30+17*len(sub)+8
def note(k,lines,w=250,title=None):
    global y
    h=18+17*len(lines)+(0)
    x=X[k]-w/2
    x=max(30,min(x,970-w))
    out.append(f'<rect x="{x:.0f}" y="{y}" width="{w}" height="{h}" class="panel" rx="4"/>')
    for i,l in enumerate(lines):
        out.append(f'<text x="{x+12:.0f}" y="{y+22+17*i}" class="sm" style="fill:#EDE7DC">{l}</text>')
    y+=h+34
y=226
msg('1','k','c','read fee data and a blockhash',['read-only RPC before the call'],dashed=True)
msg('2','k','d','execute_step(token_id, args)',['300 TGas. args hold chain environment only,','never to, value or chain'])
note('d',['Needs Triggered, step III, nothing in flight.','EVM: gas 21000 to 100000, fee ≤ 100 gwei.','Nonce is set by the contract.'],w=290)
msg('3','d','o','build_tx(payout, args)',['to, value, chain from the vault;','fees and blockhash from args'])
msg('4','o','d','payload to sign',['EIP-1559: keccak256 hash','Solana: message bytes'],dashed=True)
msg('5','d','s','sign({ payload_v2, path, domain_id })',['path base-N or sol-N. 250 TGas, 1 yocto.','The call yields; no key exists before this'])
note('s',['The MPC nodes sign with the derived key.','The yield resumes. Pending over 10 min','is marked failed and settlement moves on.'],w=300)
msg('6','s','d','on_foreign_signed(signature)',['30 TGas callback. A stale or superseded','request is ignored'],dashed=True)
note('d',['Builds the signed tx, stores signed_tx.','status = signed, next payout.','A failed MPC call: status = failed.'],w=290)
msg('7','d','k','new step',['the callback returns it. III repeats for each','payout, then IV'],dashed=True)
msg('8','k','c','relay the raw signed tx',['eth_sendRawTransaction · sendTransaction'])
msg('9','c','k','tx hash',[],dashed=True)
msg('10','k','d','mark_broadcast(token_id, index, hash)',['permissionless'])
note('d',['Recomputes the id from the stored signed_tx.','EVM: 0x + keccak256(raw tx).','Solana: base58 of the first signature.','A wrong hash panics. Right hash: status = broadcast.'],w=345)
H=int(y+70)
body='\n'.join(out)
life=''.join(f'<line x1="{X[k]}" y1="170" x2="{X[k]}" y2="{H-70}" stroke="rgba(237,231,220,.22)" stroke-dasharray="3 5"/>' for k,_,_ in names)
heads=''
for k,t,sub in names:
    x=X[k]-65
    heads+=f'<rect x="{x}" y="122" width="130" height="48" class="panel" rx="4"/><text x="{X[k]}" y="144" text-anchor="middle" class="hs" style="font-size:20px{';font-family:Inter Tight;font-weight:500;font-size:17px' if t=='v1.signer' else ''}">{t}</text><text x="{X[k]}" y="161" text-anchor="middle" class="m mg" style="font-size:11px">{sub}</text>'
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 {H}" width="1000" height="{H}" role="img" aria-labelledby="t d">
<title id="t">Settlement step III sequence</title>
<desc id="d">Keeper calls execute_step, the contract builds an omni transaction, requests a signature from v1.signer through a yield, stores the signed transaction in the callback, the keeper relays it and calls mark_broadcast, which verifies the hash.</desc>
<style>/*STYLE*/</style>
<defs>
<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 1 L9 5 L0 9" fill="none" stroke="#C8A96A" stroke-width="1.5"/></marker>
<marker id="ahg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 1 L9 5 L0 9" fill="none" stroke="#A9A399" stroke-width="1.5"/></marker>
</defs>
<rect width="1000" height="{H}" fill="#0B0C0F"/>
<text x="30" y="58" class="title">Step III, <tspan class="it">one payout per call</tspan></text>
<text x="30" y="84" class="b2">How a foreign payout is signed and then proven relayed. Dashed arrows are returns and callbacks.</text>
<line x1="30" y1="100" x2="970" y2="100" class="hair"/>
{life}
{heads}
{body}
<line x1="30" y1="{H-52}" x2="970" y2="{H-52}" class="hair"/>
<text x="30" y="{H-24}" class="sm">The keeper never supplies a destination, an amount or a chain. A signature is requested only after Triggered. Testnet only.</text>
</svg>
'''
open('src/settlement-sequence.svg','w').write(svg)
