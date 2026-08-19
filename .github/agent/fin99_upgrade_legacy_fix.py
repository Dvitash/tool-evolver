from pathlib import Path

p = Path("apps/cli/src/commands/upgrade.ts")
s = p.read_text()
start = s.index("  private async runSimulatedUpgrade(")
end = s.index("\n}\n\nexport async function upgradeCommand", start)
replacement = r'''  private async runSimulatedUpgrade(
    flags: UpgradeCommandFlags,
    currentVersion: string,
    stepsCompleted: string[],
  ): Promise<UpgradeResult> {
    const targetVersion = flags.targetVersion ?? "0.2.0";
    const versionFilePath = path.join(this.toolEvolverHome, "version.json");
    const oldVersionContent =
      (await this.fsBridge.readFile(versionFilePath)) ??
      JSON.stringify({ version: currentVersion });
    const backupDir = path.join(this.toolEvolverHome, "backups", `upgrade_test_${Date.now()}`);
    await this.fsBridge.mkdirp(backupDir);
    await this.fsBridge.writeFile(path.join(backupDir, "version.json"), oldVersionContent);

    const platformPaths = this.platformInfo
      ? resolvePlatformPaths({ home: this.homeDir, platformInfo: this.platformInfo })
      : resolvePlatformPaths({ home: this.homeDir });
    const configPath = platformPaths.configFile ?? path.join(this.toolEvolverHome, "config.json");
    const backupConfigPath = path.join(backupDir, "config.json");
    const oldConfig = await this.fsBridge.readFile(configPath);
    if (oldConfig !== null) {
      await this.fsBridge.writeFile(backupConfigPath, oldConfig);
    }
    stepsCompleted.push("backup_created");

    try {
      await this.fsBridge.writeFile(
        versionFilePath,
        JSON.stringify(
          { version: targetVersion, previousVersion: currentVersion, testOnly: true },
          null,
          2,
        ),
      );
      stepsCompleted.push("apply_release");

      const serviceManager = createUserServiceManager({
        homeDir: this.homeDir,
        toolEvolverHome: this.toolEvolverHome,
        fsBridge: this.fsBridge,
        platform: this.platformInfo?.os,
      });
      const verification = await runVerificationSuite({
        homeDir: this.homeDir,
        toolEvolverHome: this.toolEvolverHome,
        fsBridge: this.fsBridge,
        serviceManager,
        customFetch: this.customFetch,
      });
      stepsCompleted.push("health_gate");
      if (!verification.passed) {
        throw new Error(
          `Health gate verification failed: ${verification.failedChecks} check(s) failed`,
        );
      }

      return {
        success: true,
        dryRun: false,
        currentVersion,
        targetVersion,
        backupPath: backupDir,
        healthGatePassed: true,
        verificationReport: verification,
        stepsCompleted: [...stepsCompleted, "complete"],
      };
    } catch (error) {
      let rolledBack = false;
      if (!flags.noRollback) {
        stepsCompleted.push("rollback_initiated");
        try {
          await this.fsBridge.writeFile(versionFilePath, oldVersionContent);
          const backupConfig = await this.fsBridge.readFile(backupConfigPath);
          if (backupConfig !== null) {
            await this.fsBridge.writeFile(configPath, backupConfig);
          }
          rolledBack = true;
          stepsCompleted.push("rollback_completed");
        } catch {
          stepsCompleted.push("rollback_failed");
        }
      }
      return {
        success: false,
        dryRun: false,
        currentVersion,
        targetVersion,
        backupPath: backupDir,
        healthGatePassed: false,
        rolledBack,
        error: error instanceof Error ? error.message : String(error),
        stepsCompleted,
      };
    }
  }'''
p.write_text(s[:start] + replacement + s[end:])

p = Path("apps/cli/tests/platform/upgrade-and-rollback.test.ts")
s = p.read_text()
needle = "const orchestrator = new UpgradeOrchestrator({"
pos = 0
count = 0
while True:
    idx = s.find(needle, pos)
    if idx < 0:
        break
    close = s.find("        });", idx)
    if close < 0:
        raise SystemExit("could not find orchestrator close")
    block = s[idx:close]
    if 'releaseMode: "test-simulated"' not in block:
        insert = close
        # constructors in this file use 8-space property indentation
        s = s[:insert] + '          releaseMode: "test-simulated",\n' + s[insert:]
        pos = insert + 50
        count += 1
    else:
        pos = close + 1
if count != 3:
    raise SystemExit(f"expected 3 legacy upgrade constructors, updated {count}")
p.write_text(s)
print("FIN-003 legacy upgrade suite aligned")