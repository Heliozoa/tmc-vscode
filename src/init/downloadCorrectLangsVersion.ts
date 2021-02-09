import { sync as delSync } from "del";
import * as fs from "fs-extra";
import * as path from "path";
import { Err, Ok, Result } from "ts-results";

import Dialog from "../api/dialog";
import { TMC_LANGS_RUST_DL_URL, TMC_LANGS_RUST_VERSION } from "../config/constants";
import { downloadFile, getPlatform, getRustExecutable, Logger } from "../utils";

/**
 * Downloads correct langs version for the current extension version, unless already present. Will
 * remove any previous versions in the process.
 *
 * @param cliFolder
 */
async function downloadCorrectLangsVersion(
    cliFolder: string,
    dialog: Dialog,
): Promise<Result<string, Error>> {
    const platform = getPlatform();
    Logger.log("Detected platform " + platform);
    Logger.log("Platform " + process.platform + " Arch " + process.arch);

    const executable = getRustExecutable(platform);
    Logger.log("Executable " + executable);

    const cliPath = path.join(cliFolder, executable);
    if (fs.existsSync(cliPath)) {
        return Ok(cliPath);
    }

    delSync(cliFolder, { force: true });

    const cliUrl = TMC_LANGS_RUST_DL_URL + executable;
    Logger.log(`Downloading TMC-langs from ${cliUrl} to ${cliPath}`);
    const langsDownloadResult = await dialog.progressNotification(
        `Downloading TMC-langs ${TMC_LANGS_RUST_VERSION}...`,
        async (progress) =>
            await downloadFile(cliUrl, cliPath, undefined, (percent) =>
                progress.report({ percent }),
            ),
    );
    if (langsDownloadResult.err) {
        Logger.error("An error occurred while downloading TMC-langs:", langsDownloadResult.val);
        return langsDownloadResult;
    }

    try {
        const fd = await fs.open(cliPath, "r+");
        await fs.fchmod(fd, 0o111);
        await fs.close(fd);
    } catch (e) {
        Logger.error("Error changing permissions for CLI", e);
        return Err(e);
    }

    return Ok(cliPath);
}

export { downloadCorrectLangsVersion };
