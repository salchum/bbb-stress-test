FROM node:18-bookworm-slim AS core

RUN apt-get update && \
    apt-get install -y \
      chromium \
      xvfb \
      ffmpeg \
      ca-certificates \
      fonts-ipafont-gothic \
      fonts-wqy-zenhei \
      fonts-thai-tlwg \
      fonts-kacst \
      fonts-freefont-ttf \
      --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

COPY ./docker/files/usr/local/bin/entrypoint /usr/local/bin/entrypoint

RUN chmod +x /usr/local/bin/entrypoint
RUN chmod g=u /etc/passwd

ENTRYPOINT ["/usr/local/bin/entrypoint"]

ARG DOCKER_USER=1000
USER ${DOCKER_USER}

CMD ["chromium"]

FROM core AS development

CMD ["/bin/bash"]

FROM core AS dist

USER root

COPY . /app
WORKDIR /app

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

RUN yarn install --frozen-lockfile

ARG DOCKER_USER=1000
USER ${DOCKER_USER}

CMD ["./cli.js","stress"]
