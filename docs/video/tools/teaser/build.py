# Voice first: generate the three lines (with word timings), build the timeline from them, write the picture's html.
# usage: ELEVENLABS_API_KEY=... python3 build.py vo <voice id> "<line a>" "<mark in a>" "<card a1>" "<card a2>" "<line b>" "<card b>"
# The committed cut:
#   python3 build.py vo kqVT88a5QfII1HNAEPTJ "If you die tonight... your agent keeps spending." "your" \
#       "If you die tonight," "your agent keeps spending." "Not anymore." "Not anymore."
# It rewrites vo/ (a.mp3, b.mp3, c.mp3, align.json, timeline.json) and the `const TL = ...` line of teaser.html.
import json, sys, urllib.request, base64, os
d, vid, la, mark, card1, card2, lb, cardb = sys.argv[1:9]
os.makedirs(d, exist_ok=True)
LINES = [('a', la, mark), ('b', lb, None), ('c', "Your crypto shouldn't die with you.", None)]
al = {}
for i, (key, text, mk) in enumerate(LINES):
    body = {"text": text, "model_id": "eleven_multilingual_v2", "seed": 5,
            "voice_settings": {"stability": 0.8, "similarity_boost": 0.8, "style": 0.0, "use_speaker_boost": True, "speed": 0.92},
            "previous_text": LINES[i - 1][1] if i else None, "next_text": LINES[i + 1][1] if i + 1 < len(LINES) else None}
    body = {k: v for k, v in body.items() if v is not None}
    req = urllib.request.Request(f"https://api.elevenlabs.io/v1/text-to-speech/{vid}/with-timestamps?output_format=mp3_44100_192", data=json.dumps(body).encode(), headers={'content-type': 'application/json', 'xi-api-key': os.environ['ELEVENLABS_API_KEY']})
    r = json.load(urllib.request.urlopen(req, timeout=120))
    open(f'{d}/{key}.mp3', 'wb').write(base64.b64decode(r['audio_base64']))
    a = r['alignment']; chars = ''.join(a['characters']); st, en = a['character_start_times_seconds'], a['character_end_times_seconds']
    al[key] = {'start': next(st[j] for j, c in enumerate(a['characters']) if c.strip()), 'end': max(en[j] for j, c in enumerate(a['characters']) if c.isalpha()),
               'mark': st[chars.index(mk)] if mk else None}
    print(key, text, '| speech', round(al[key]['start'], 2), 'to', round(al[key]['end'], 2), '| mark', al[key]['mark'] and round(al[key]['mark'], 2))
json.dump(al, open(f'{d}/align.json', 'w'), indent=1)
r3 = lambda x: round(x, 3)
tA = float(os.environ.get('TA', '0.95')); T_FLAT = r3(tA + al['a']['end'] + 0.25)
tB = r3(T_FLAT + 0.55); T_STEPS = r3(tB + al['b']['end'] + 0.12); STEP = 0.32
T_SETTLED = r3(T_STEPS + 5 * STEP); T_END = r3(T_SETTLED + 0.42); tC = r3(T_END + 0.13); T_LAST = r3(tC + al['c']['end'] + 0.22); DUR = r3(T_LAST + 0.62)
beats = [0.35]; gap = 0.80
while beats[-1] + gap <= T_FLAT - 0.11: beats.append(r3(beats[-1] + gap)); gap = max(0.14, gap * 0.82)
TL = {'DUR': DUR, 'BEATS': beats, 'T_FLAT': T_FLAT, 'T_TRIG': tB, 'T_STEPS': T_STEPS, 'STEP': STEP, 'T_SETTLED': T_SETTLED, 'T_END': T_END, 'T_LAST': T_LAST,
      'WORDS': [[tA, r3(tA + al['a']['mark']), card1, 'serif'], [r3(tA + al['a']['mark']), T_FLAT, card2, 'serif']], 'TRIG_TEXT': cardb, 'VO': {'a': tA, 'b': tB, 'c': tC}}
json.dump(TL, open(f'{d}/timeline.json', 'w'), indent=1)
s = open('teaser.html').read()
i = s.index('const TL = '); j = s.index(';\n', i)
open('teaser.html', 'w').write(s[:i] + 'const TL = ' + json.dumps(TL) + s[j:])
print('duration', DUR, 's; flatline', T_FLAT, '; steps', T_STEPS, '; end card', T_END, '; frames', round(DUR * 30))
