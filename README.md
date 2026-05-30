# A stress testing tool for BigBlueButton

## Overview

This is a stress testing tool for [BigBlueButton](https://bigbluebutton.org/).

It simulates client activity in a BBB conference with [Puppeteer](https://pptr.dev/).
The Docker setup is intended for a single server where each test is run as a
fresh one-off container command.

## Configuration

1. Prepare the environment file:

   ```bash
   cp .env.default .env
   ```

2. Edit `.env` and set at least:

   ```env
   BBB_URL=
   BBB_SECRET=
   BBB_MEETING_ID=
   BBB_CLIENTS_WEBCAM=1
   BBB_CLIENTS_MIC=0
   BBB_CLIENTS_LISTEN_ONLY=0
   BBB_TEST_DURATION=60
   BBB_BOT_AUDIO_FILE=./audio.wav
   BBB_BOT_VIDEO_FILE=./webcam.y4m
   BBB_BOT_DEBUG_DIR=./screenshots
   BBB_BOT_REPORT_DIR=./reports
   ```

3. Put the runtime media files on the host:

   ```text
   ./audio.wav
   ./webcam.y4m
   ```

   These files are mounted into the container and are not baked into the image.

Screenshots are written to `./screenshots` on the host. Structured JSONL report
logs are written to `./reports`.

## Make Commands

Make commands use Docker Compose, so Node does not need to be installed on the
host:

```bash
make docker-build
make install
make list-meetings
make stress
make stress ARGS="test-1234 -w 3 -m 2 -l 4 -d 30 -v"
```

Values in `.env` are defaults. CLI arguments passed through `ARGS` override
those defaults for a single run.

`make stress` and `make list-meetings` do not rebuild the Docker image. Run
`make docker-build` after code changes.

`make stress` also prepares `./reports` and `./screenshots` and runs the
container with your current host UID/GID so report files can be written.

## Docker Deployment

4. Build the deployable image:

   ```bash
   docker compose build app
   ```

5. Run commands whenever needed:

   ```bash
   docker compose run --rm app ./cli.js list-meetings
   docker compose run --rm app ./cli.js stress test-1234 -w 3 -m 2 -l 4 -d 30 -v
   ```

   Docker Compose overrides media, screenshot, and report paths to `/app/...`
   inside the container.

   Rebuild explicitly after code changes:

   ```bash
   make docker-build
   ```

If Docker cannot write reports or screenshots, fix host directory permissions:

```bash
mkdir -p reports screenshots
chmod 777 reports screenshots
```

Each stress test creates a report file named like:

```text
stress-report-YYYYMMDD-HHMMSSZ.jsonl
```

The file contains one JSON object per important event, including `run_started`,
`client_started`, `client_joined`, `audio_connected`, `webcam_started`,
`chat_sent`, `client_ready`, `client_failed`, `run_clients_processed`, and
`run_finished`.

To force a specific report filename for one run, set:

```env
BBB_BOT_REPORT_FILE=my-test-report.jsonl
```

See [CAPACITY_TEST_PLAN.md](./CAPACITY_TEST_PLAN.md) for the scalable BBB
capacity test plan.

## Common Stress Options

```text
meeting              Meeting ID. Defaults to BBB_MEETING_ID.
-w, --webcams        Number of clients with webcam and microphone.
-m, --microphones    Number of clients with microphone only.
-l, --listening      Number of clients in listen-only mode.
-d, --duration       Test duration in seconds after clients are connected.
-v, --verbose        Enable verbose logs.
```

## License

This work is released under the MIT License (see [LICENSE](./LICENSE)).
