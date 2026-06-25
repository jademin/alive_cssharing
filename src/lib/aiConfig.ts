import fs from "fs/promises";
import path from "path";
import { isVercelProd, githubRead } from "./githubStorage";

const CONFIG_PATH = path.join(process.cwd(), "data", "ai-config.json");
const GH_CONFIG_PATH = "data/ai-config.json";

export interface AIConfig {
  provider: "mock" | "claude" | "openai";
  apiKey: string;
  model: string;
}

export async function loadAIConfig(): Promise<AIConfig> {
  try {
    let raw: string;
    if (isVercelProd()) {
      raw = await githubRead(GH_CONFIG_PATH);
    } else {
      raw = await fs.readFile(CONFIG_PATH, "utf-8");
    }
    return JSON.parse(raw.replace(/^﻿/, "")) as AIConfig;
  } catch {
    return { provider: "mock", apiKey: "", model: "" };
  }
}

export async function saveAIConfig(config: AIConfig, token?: string): Promise<void> {
  const { githubWrite } = await import("./githubStorage");
  const json = JSON.stringify(config, null, 2);
  if (isVercelProd()) {
    await githubWrite(GH_CONFIG_PATH, json, token);
    return;
  }
  await fs.writeFile(CONFIG_PATH, json, "utf-8");
}
