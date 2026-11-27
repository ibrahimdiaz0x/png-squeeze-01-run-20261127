# squeeze-png — Squeeze screenshots into the smallest PNG

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![Rank](https://make.fun/badge/png-squeeze-01-run-20261127/ibrahimdiaz0x/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![Reward](https://make.fun/badge/png-squeeze-01-run-20261127/ibrahimdiaz0x/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Built for the [make.fun PNG squeeze bounty](https://make.fun/bounty/png-squeeze-01-run-20261127):
one program, `main.ts`, that answers every instance of a set — eight 1280×720
RGBA screenshots — with the smallest lossless PNG it can write, in one run,
inside the 60-second wall, using Node 22's standard library only.

## How it squeezes

1. **Decode** the stored input PNG (colour type 6, rows unfiltered) to RGBA.
2. **Analyse** what the image holds — opaque or not, grey or not, at most 256
   colours or not — and build every lossless form it can take: a palette
   (entries by count, or by luminance, transparent ones first so `tRNS`
   stays short), grey / grey+alpha, RGB, or RGBA, with a `tRNS` key when
   exactly one value is fully transparent and nothing else uses it.
3. **Screen** every form under several per-row filterings: each row
   unfiltered, Sub, Up, Paeth, the minimum-signed-sum row choice, the
   fewest-distinct-pairs row choice, and brute force (each row's five filters
   weighed by a real deflate of the row after the 32 KiB written before it).
   The screen weighs each filtered form by zlib level 6 plus its PLTE/tRNS
   chunk bytes, the same weighing the contest's own scale compressor uses.
4. **Re-encode** the winning filtered bytes three ways and keep the smallest:
   zlib level 9 (default strategy), zlib level 9 (filtered strategy), and
   this file's own optimal-parsing deflate — hash-chain LZ77 match finding,
   a dynamic-programming optimal parse over Pareto-optimal (length,
   distance) candidates, length-limited dynamic Huffman codes with an exact
   Kraft-sum repair, one re-parse under the dynamic costs, one block per
   256 KiB of input.
5. **Write** the PNG: IHDR, PLTE, tRNS, one IDAT, IEND, each CRC correct,
   bit depth 8, no interlace, no other chunks.

Everything is deterministic — no clock, no randomness, no environment reads
beyond the input/output directories the harness names — so the two grading
executions write the same bytes.

## Practice-set score

On the kit's practice set (8 instances), scored by the kit's own scorer:

| | score |
|---|---|
| house baseline, fixed-paeth 1.0.0 | 420,399 |
| scale (the contest's own level-6 screen) | 666,661 |
| **this entry** | **719,503** |
| house reference (optimal-parsing deflate) | ~760,000–790,000 |

One run over the whole practice set takes about 37 seconds on this machine,
inside the 60-second wall.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `/input/<id>/image.png` for each instance id and writes
`/output/<id>/image.png`, creating the directories itself. It throws on any
input that is not a 1280×720 PNG, so a bad instance fails loudly instead of
writing a wrong answer.

## Licence

MIT — see [LICENSE](LICENSE). The PNG filter, palette and screening ideas
follow the contest kit's own published helpers (`program/scorer/checker/
png.mjs`, `program/generator/subject/scale.mjs`, MIT); the optimal-parsing
deflate encoder in `main.ts` is original work written for this entry.
