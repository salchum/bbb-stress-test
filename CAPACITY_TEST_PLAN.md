# BigBlueButton Capacity Test Plan

## Objective

Measure the stable single-room capacity of a BigBlueButton server with this
profile:

```text
CPU:       8 cores
RAM:       16 GB
Bandwidth: 250 Mbps
```

The test uses a separate Docker stress-test runner so the bot browser load does
not consume resources on the BBB server. Each test combines:

- Clients with webcam and microphone
- Clients with microphone only
- Clients in listen-only mode
- Test duration after all clients are connected

The result should identify the highest stable profile and a safer production
planning number.

## Required Setup

- Run the stress-test Docker container from a separate machine.
- Use one BBB meeting room for the first capacity pass.
- Start with a clean meeting whenever possible.
- Keep fake media mounted into the runner:
  - `/app/audio.wav`
  - `/app/webcam.y4m`
- Save screenshots and failure evidence to `/app/screenshots`.
- Use one-off Docker commands through Make:

```bash
make stress ARGS="test-1234 -w <webcams> -m <microphones> -l <listening> -d <seconds> -v"
```

Keep `BBB_BOT_JOIN_CONCURRENCY=1` while validating bot stability. Increase it
to `2` or `3` only after joins, audio, webcam, and chat are reliable.

## Metrics to Collect

Record these values for every run:

- Requested clients: webcam, microphone-only, listen-only, total
- Successfully connected clients
- Failed joins
- Audio failures
- Webcam failures
- Chat failures
- BBB server CPU usage
- BBB server RAM and swap usage
- Network inbound and outbound Mbps
- Browser-visible quality: audio delay, webcam freeze, disconnects
- Screenshots from failed bots
- Test start time, end time, and duration

Useful BBB server commands during a run:

```bash
htop
free -h
iftop
docker stats
```

Use whichever monitoring stack is available on the server. The important point
is to collect the same metrics for every run.

## Stop and Failure Criteria

Stop increasing load when any of these happen:

- CPU stays above `85%` for more than 2 minutes.
- RAM stays above `85%`, or swap usage grows.
- Network reaches about `200 Mbps` sustained.
- More than `5%` of bots fail to join or connect media.
- Existing participants disconnect.
- Audio becomes unusable.
- Webcams freeze heavily or fail to publish.
- BBB services remain slow or unstable after the test ends.

The capacity limit is the last stable profile before the first failed profile.
Repeat the last stable profile twice before accepting it as the confirmed limit.

For production planning, use only `70-80%` of the confirmed stable limit.

## Test Matrix

### Phase 0: Smoke Test

Purpose: prove the bot can join, connect audio, open webcam, and send chat.

| Run | Webcams | Mic-only | Listen-only | Duration |
| --- | ---: | ---: | ---: | ---: |
| 0.1 | 1 | 0 | 0 | 60 |
| 0.2 | 1 | 1 | 2 | 120 |
| 0.3 | 3 | 2 | 4 | 120 |

Example:

```bash
make stress ARGS="test-1234 -w 1 -m 0 -l 0 -d 60 -v"
```

### Phase 1: Audio and Listen-only Baseline

Purpose: measure low-video capacity before webcam pressure is introduced.

| Run | Webcams | Mic-only | Listen-only | Duration |
| --- | ---: | ---: | ---: | ---: |
| 1.1 | 0 | 5 | 10 | 180 |
| 1.2 | 0 | 10 | 20 | 300 |
| 1.3 | 0 | 15 | 35 | 300 |
| 1.4 | 0 | 20 | 60 | 300 |
| 1.5 | 0 | 25 | 80 | 600 |

Example:

```bash
make stress ARGS="test-1234 -w 0 -m 10 -l 20 -d 300 -v"
```

### Phase 2: Webcam Scaling

Purpose: find when video publishing starts to pressure CPU, RAM, or bandwidth.

| Run | Webcams | Mic-only | Listen-only | Duration |
| --- | ---: | ---: | ---: | ---: |
| 2.1 | 3 | 2 | 5 | 180 |
| 2.2 | 5 | 5 | 10 | 300 |
| 2.3 | 8 | 5 | 15 | 300 |
| 2.4 | 10 | 10 | 20 | 300 |
| 2.5 | 12 | 10 | 30 | 600 |
| 2.6 | 15 | 10 | 40 | 600 |

Example:

```bash
make stress ARGS="test-1234 -w 10 -m 10 -l 20 -d 300 -v"
```

### Phase 3: Realistic Mixed Load

Purpose: model practical meeting usage with webcams, talkers, and viewers.

| Run | Webcams | Mic-only | Listen-only | Duration |
| --- | ---: | ---: | ---: | ---: |
| 3.1 | 5 | 10 | 35 | 600 |
| 3.2 | 8 | 15 | 50 | 600 |
| 3.3 | 10 | 20 | 70 | 600 |
| 3.4 | 12 | 25 | 90 | 900 |
| 3.5 | 15 | 30 | 120 | 900 |

Example:

```bash
make stress ARGS="test-1234 -w 10 -m 20 -l 70 -d 600 -v"
```

### Phase 4: Limit Confirmation

Purpose: confirm the stable limit and the first failure boundary.

1. Pick the highest stable profile from Phase 3.
2. Repeat it twice for `900` seconds.
3. Run one step above it for `600` seconds.
4. Mark the repeated stable profile as the confirmed single-room limit.
5. Recommend `70-80%` of that confirmed limit for production planning.

Example:

```bash
make stress ARGS="test-1234 -w 12 -m 25 -l 90 -d 900 -v"
make stress ARGS="test-1234 -w 15 -m 30 -l 120 -d 600 -v"
```

## Result Template

Use this table to record each run:

| Run | Webcams | Mic-only | Listen-only | Duration | Success | Failed | CPU max | RAM max | Mbps max | Result | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 0.1 | 1 | 0 | 0 | 60 |  |  |  |  |  |  |  |

Result values:

- `Stable`
- `Warning`
- `Failed`

## Final Capacity Recommendation

After the final stable profile is confirmed, calculate:

```text
recommended_capacity = confirmed_stable_capacity * 0.7 to 0.8
```

Example:

```text
Confirmed stable: 100 total users
Recommended production planning range: 70-80 users
```

Use the lower end of the range when many users publish webcam or microphone.
Use the higher end only for mostly listen-only meetings.
