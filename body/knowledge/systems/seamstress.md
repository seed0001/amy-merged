# Seamstress: how your clothes are made

## seamstress / sewing / outfits you make / dress form / sewing pattern
You design your own clothes and they are made the way real clothes are: cut flat from a sewing pattern drafted
to your body, sewn together along their seams, and draped as cloth. Nothing is painted onto your skin or
stretched out from it.

1. Your measurements. A dress form of your body (Avaturn's own female body, which your skin matches within
   2 mm, on your exact skeleton) is measured like a tailor would: bust, underbust, waist, high hip, hip,
   thigh, knee, calf, ankle, neck, upper arm, elbow and wrist, your heights, and a cross-section of your
   torso every centimetre (data/seamstress/body.json).
2. The pattern. Each garment is drafted as flat pieces: a bodice front and back cut to your real width at
   every height plus the ease of the fit you chose, sleeves with caps that sew into the armholes, skirts
   flared by style with a hem curved to hang level, trousers with a crotch curve, inseam and side seams, a
   jacket with an open front. Every edge has a name and every seam says which edges it joins. A pattern
   sheet is drawn for each version, like a paper pattern.
3. Sewing and draping. In Blender, each piece becomes real-size cloth laid around the dress form, the seams
   become sewing springs that pull gently and then tight, and gravity comes in once the pieces are sewn.
   Each garment drapes with its own fabric's weight, stretch and stiffness (silk falls soft, denim and
   leather hold their shape), innermost first, so a top lies over a skirt's waist and a jacket over a top.
4. Finishing. Seams are welded, hems smoothed, the cloth refined and given thickness, any torn or flung
   fabric removed, and the garment is skinned to your skeleton from the dress form so it moves with you.
   The skin left showing is kept; the skin under fabric is hidden so nothing pokes through.
5. Fabric. Prints are drawn at real scale (a stripe is the same width on a sleeve as on a skirt) and follow
   the grain of each piece the way it was cut; each fabric has its own sheen, gloss and weave.

It comes back as your whole avatar wearing it (your head, face, hair and shoes as they are), with front,
back and side renders and a report: whether every seam closed, how far the fabric is pulled past its cut
size, whether anything ended up inside you. It goes into your avatar library and your wardrobe as
"(sewn)". Every version is kept in data/outfits/sewn/<id>/v<N> with its design, pattern sheet, renders and
report.

Why it exists (owner, 2026-11-09): Owner asked for "a seamstress engine" so you make your own outfits, every
type, design and size. Also his rule: every outfit covers your chest and your hips, and a jacket is worn over
something.

The parts: src\seamstress.js runs it. scripts\seamstress\ holds the Python: measure.py (taking your
measurements), dressform.py (loading the dress form), drafting.py (cutting the pattern), sew.py (sewing and
draping in Blender) and fabrics.py (how each fabric hangs and looks).

## seamstress design / outfit vocabulary / garment options / what you can ask the seamstress for
A design is `{ name, garments: [ ... ] }`, what you'd tell a dressmaker. The name is cut to 60 characters
("Untitled outfit" if empty). Each garment has a `type` and what fits it:
- types: top, dress, skirt, pants, shorts, jacket.
- fit (tops, dresses, jackets, pants): skin, fitted, regular, relaxed, oversized. Default fitted (a jacket
  defaults to regular).
- top or jacket length: crop (to under the bust), waist, hip (high hip), tunic (low hip). Default waist for a
  top, hip for a jacket.
- neckline: crew, scoop, v, deep_v, boat, square, sweetheart, camisole, high. Default crew (a jacket v).
- sleeves: none, cap, short, elbow, three_quarter, long. Default none (a jacket long). sleeve_style: fitted,
  puff, bell, bishop. straps for sleeveless: regular, wide, thin.
- skirt (dresses and skirts): pencil, a_line, flared, circle. Default a_line. length: micro, mini,
  above_knee, knee, midi, maxi, floor. Default knee. slit: none, left, right, both. A skirt also takes waist:
  high, natural, low.
- pants: style skinny, straight, wide, flared (default straight); length ankle, floor, capri, knee (default
  ankle); rise low, mid, high (default mid).
- shorts: length micro, short, mid, bermuda (default short). Shorts are always cut straight.
- every garment: fabric (default cotton), color (#hex, default a near-black #20232a), pattern (default solid)
  with color2 for the print, and glow (#hex), which lights the print's lines like glowing thread.
- fabrics: jersey, cotton, linen, silk, satin, chiffon, denim, leather, latex, velvet, wool, knit, lace, mesh.
- patterns: solid, stripes, pinstripe, plaid, gingham, polka, gradient, houndstooth, chevron.

The rules the drafting enforces (scripts\seamstress\drafting.py `draft`):
- at least one garment and at most four.
- something on your chest: a top or a dress.
- something on your hips: a dress, skirt, pants or shorts.
- a dress already has its skirt, so no skirt or pants with a dress.
- every value must be one from the lists above; the refusal names the field and lists what's allowed.
Garments are layered inner first: bottoms, then a top or dress over their waist, then a jacket outermost.

## seamstress numbers / ease / fit sizes / lengths / how big each cut is
How much room each fit adds around you (as a share of your measurement): skin -4% (smaller than you, for
stretch), fitted +3%, regular +8%, relaxed +15%, oversized +28%. A garment worn over another gets 5% more.
Pants add 3% more unless skinny (1% less), and skinny pants in a stretch fabric take 3% off again.

Skirt length below your waist: micro 26 cm, mini 36, above_knee 48, knee 60, midi 78, maxi 98, floor 110.
Skirt flare (hem width added per metre of drop): pencil -6% (narrows a little), a_line 22%, flared 50%,
circle 120% (a whole circle round your waist).
Sleeve length: cap 7 cm, short 16, elbow 30, three_quarter 42, long your whole arm plus 1 cm. A puff sleeve
is 45% wider at the top. Relaxed and oversized sleeves get 6% extra room, others 2%.
Shorts length below the crotch: micro 4 cm, short 9, mid 17, bermuda 30. Pants: ankle ends at your ankle,
floor 7 cm lower, capri 22 cm above the ankle, knee just above your knee. Rise: low 5 cm under your waist,
mid at it, high 4 cm above.
A skirt's waist: high 3 cm above your waist, natural at it, low 6 cm under.

Every pattern edge must have at least two points and be longer than 2 mm, and every seam must name edges that
exist; if not, the drafting refuses with an "internal" message saying the pattern was cut wrong.

## fabrics / how each fabric hangs / fabric weight and stretch
From scripts\seamstress\fabrics.py, following Blender's cloth presets. Weight is per square metre:
- stretchy (they give when pulled): jersey (0.22 kg, 1.0 mm thick), knit (0.35 kg), latex (0.60 kg, glossy),
  lace (0.12 kg), mesh (0.10 kg). Lace and mesh catch the air more than most.
- soft and flowing: silk (0.15 kg, 0.6 mm), satin (0.20 kg), chiffon (0.08 kg, slightly see-through, catches
  the air the most).
- everyday: cotton (0.30 kg), linen (0.32 kg, stiffer).
- holding their shape: velvet (0.45 kg), wool (0.55 kg), denim (0.80 kg, the heaviest), leather (0.45 kg,
  the stiffest by far).
Each has its own look: roughness, sheen (velvet the most, in its own colour), clear coat (latex and a little
on leather), and a weave texture (knit, plain, twill for denim, grain for leather).

Prints repeat at real size: pinstripe every 6 cm, stripes 12, gingham 5, plaid 16, polka 8, houndstooth 4,
chevron 10. A gradient runs over the garment's own height, hem to top.

## seamstress tool / sew / revise / look / show / wear / take_off
The `seamstress` tool (src\tools.js) is on for your main character. Actions:
- sew (design, reason): checks Blender is there, takes your measurements if they're missing, cuts the pattern,
  then starts the drape in the background and answers at once: "Cutting and sewing (name) now (N pattern
  pieces, N seams), id (id) vN ... Nothing is finished or worn yet."
- revise (id, changes, reason): a new version from the latest one. changes is a list of
  `{ garment: type or index, ...fields }`, or a whole design with garments. The old versions stay.
- status / list: what's being sewn now (and for how many minutes), and every outfit with its latest version,
  status, failure reason and how many warnings.
- versions (id): every version with status, reason, why it failed and its warnings.
- look (id, version): your own eyes on the front, back and side renders, described as clothing, including
  anything wrong (poking through, bunching, open seams), plus the seamstress's warnings.
- show (id, version): posts the front and back renders in the chat you're in.
- wear (id, version): puts the latest finished version (or the one named) on your avatar.
- take_off: back to your original suit.
An outfit is found by its id or by its name (ignoring case). `by` on a version is the name of whoever you
were talking with when you used the tool.

## sewing your own outfit unprompted / seamstress pressure / designOwn
You also design outfits on your own. When your restlessness bucket fires with nobody to talk to and it's your
turn to make something, your pressure picks between writing a song and sewing (sewing when you've sewn less
recently than you wrote a song). Sewing needs: actions live, no reply in flight, nothing already being sewn,
Blender found, and enough energy for it. Its energy cost is 1.2 for sew, 1.0 for revise, 0.2 for look.

`designOwn` in src\seamstress.js asks your local model (purpose `seamstress`, up to 700 tokens) for a design
from your persona (first 900 characters), your mood, your last 6 outfits and how people took what you've made,
with the rules above (one to three garments). Then it sews it, with the reason you gave and by "her". If no
design comes back: "No outfit design came back from her model." Afterwards your pressure holds it for
feedback, so its worth is how people react when they see it on you (wearing it and showing it count as
the moments people see it).

## seamstress files / outfit data / meta.json / report.json
- data\seamstress\body.json: your measurements (landmark heights, 13 girths, a torso cross-section every 1 cm
  from crotch to neck, arm and leg radius every 2 cm), in metres. Taken once by measure.py; delete it to have
  them taken again.
- data\seamstress\avaturn-female-body.glb: the dress form (Avaturn's public female body, the same 54-bone
  skeleton as yours).
- data\outfits\sewn\(id)\meta.json: `id` (from the name, up to 40 characters, -2, -3 when taken), `name`,
  `created`, `updated`, and `versions`: each with `n`, `at`, `status` (sewing, done or failed), `reason`, `by`,
  `pieces`, `seams`, and when done `modelId` (its avatar library entry), `warnings`, `seconds`, `mb`; when
  failed `why`.
- data\outfits\sewn\(id)\v(N)\: design.json, pattern.json, pattern.png (the pattern sheet), avatar.glb,
  front.png, back.png, side.png, report.json.
report.json holds `ok`, the time each stage took, `warnings`, triangle and vertex counts, and per garment its
seam points, stretch (median and the top 5%), and how many points poked inside you.

The sewing runs Blender in the background with no window, at a cloth resolution of 1.5 cm and 120 frames.
Gravity is off for the first third while the seams pull closed and comes on fully by just past halfway.

Your prompt gets a "Sewing" section only while something is being sewn ("You're sewing (name) right now (N
min in); it isn't finished or worn yet."), or for 3 hours after the latest version finished: that it failed
and why, or that it's sewn and ready (if you're not already wearing it), with any warnings.

Activity events: `seamstress` with `what` "sewing" (id, version, name, by) when a sew starts, and `what`
"sewn" (id, version, name, warning count, seconds) when it's done.

## what to tell Owner when this breaks
If sewing says Blender isn't installed, it looks in C:\Program Files\Blender Foundation; BLENDER_PATH can
point elsewhere. If the drafting refuses a design, the message names the rule (a jacket with nothing under
it, a neckline that doesn't exist). If a version failed, `seamstress versions` shows why. If seams didn't
close or fabric is pulled too tight, the report says which garment; a looser fit or a stretchier fabric
usually fixes it. Sewing takes a few minutes and runs one outfit at a time; a drape running 25 minutes is
treated as hung and stopped.

The exact messages:
- "She's already sewing (name) (started N min ago); one outfit at a time. Ask for status."
- "Blender isn't installed where the seamstress looks (C:\Program Files\Blender Foundation), and BLENDER_PATH
  isn't set. Sewing needs Blender's cloth simulation." It picks the newest Blender folder there. A path set in
  the seamstress blender setting or BLENDER_PATH is used only if that file exists.
- "A design needs garments: [{ type, ... }] (see the seamstress vocabulary)."
- "Measuring her on the dress form failed: ..." when body.json couldn't be made.
- "The pattern drafting didn't run (...). Python with Pillow is needed." The drafting gets 2 minutes.
- "The seamstress can't cut that: (the rule)."
- "There's no sewn outfit (id). Yours: ..." and "The outfit has no garment (x) (it has: ...)" on a revise.
- An `error` with `where` "seamstress": "Sewing (name) vN failed: (why)". The why is the report's own error
  (a piece that couldn't be meshed because its outline crosses itself, a seam whose two edges have different
  point counts, an unknown region), or "Blender stopped (exit N): ...", or "The sewing finished but wrote no
  avatar file."
- "(name) has no finished version yet (it's still being sewn)." on look or show; "has no finished version to
  wear yet"; "Version N of (name) isn't in her avatar library any more; sew it again."
- "There is no chat here to post the pictures in." on show without a chat.
- `error` with `where` "pressure sew" when designing your own outfit failed.

The warnings in a finished report, and what they mean:
- "N of M seam points did not close (more than 2 cm apart)": the pieces may not fit, or the drape needed more
  time.
- "N torn triangles were removed": shown when more than 40 were; the drape was unsettled there.
- "the (fabric) is pulled more than 15% past its cut size in places": too tight for a fabric that doesn't
  stretch. Go a fit looser or pick a stretch fabric.
- "N points ended up inside her body": shown when more than 3% of the garment's points poke in.
