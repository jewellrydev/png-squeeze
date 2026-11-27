# png-squeeze

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/jewellrydev/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/jewellrydev/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG compressor in TypeScript (Node 22, standard library only) that re-encodes 1280x720 RGBA screenshots into the smallest valid PNG it can: colour-type and palette reduction, per-row adaptive filtering, and level-9 deflate, keeping the smallest of every honest encoding it tries.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

For each instance directory `<id>` under the input dir, it reads `<id>/image.png` and writes the same image, pixel for pixel, to `<output>/<id>/image.png`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=irene-adler&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
