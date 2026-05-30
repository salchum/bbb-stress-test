#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function loadDotEnv(filePath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadDotEnv();

const { getEnv } = require("./lib/command-helpers");

const yargs = require("yargs");

const listMeetings = require("./lib/commands/list-meetings");
const stress = require("./lib/commands/stress");

const defaultBuilder = (yargs) => yargs;

const argv = yargs
  .command(
    listMeetings.name,
    listMeetings.description,
    listMeetings.options || defaultBuilder,
    listMeetings.handler
  )
  .command(
    stress.name,
    stress.description,
    stress.options || defaultBuilder,
    stress.handler
  )
  .option("bbb-url", {
    alias: "u",
    type: "string",
    description: "BBB API url",
  })
  .option("bbb-secret", {
    alias: "s",
    type: "string",
    description: "BBB secret",
  })
  .option("verbose", {
    alias: "v",
    type: "boolean",
    description: "Run with verbose logging",
  })
  .default("bbb-url", getEnv("BBB_URL"))
  .default("bbb-secret", getEnv("BBB_SECRET"))
  .demandOption(
    ["bbb-url", "bbb-secret"],
    "Please provide bbb-secret and bbb-url options. You can find the values by running bbb-conf --secret on your BBB server"
  )
  .demandCommand(1, "")
  .strict().argv;
