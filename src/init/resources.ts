import * as fs from "fs";
import * as glob from "glob";
import * as path from "path";
import * as vscode from "vscode";
import * as unzipper from "unzipper";

import { Err, Ok, Result } from "ts-results";
import Resources from "../config/resources";
import { downloadFile, getPlatform, isJavaPresent } from "../utils/";
import {
    EXTENSION_ID,
    JAVA_ZIP_URLS,
    TMC_JAR_NAME,
    TMC_JAR_URL,
    WORKSPACE_ROOT_FILE,
    WORKSPACE_ROOT_FILE_TEXT,
    WORKSPACE_SETTINGS,
} from "../config/constants";
import Storage from "../config/storage";
import del = require("del");

/**
 * Checks if Java is present and performs resource initialization on extension activation
 * @param extensionContext Extension context
 */
export async function resourceInitialization(
    extensionContext: vscode.ExtensionContext,
    storage: Storage,
): Promise<Result<Resources, Error>> {
    const extensionVersion = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON.version;

    const cssPath = extensionContext.asAbsolutePath("resources/styles");
    const htmlPath = extensionContext.asAbsolutePath("resources/templates");
    const mediaPath = extensionContext.asAbsolutePath("media");

    const tmcDataPath =
        storage.getExtensionSettings()?.dataPath ||
        path.join(extensionContext.globalStoragePath, "tmcdata");

    let javaPath: string;
    const javaDownloadPath = path.join(tmcDataPath, "java");

    if (await isJavaPresent()) {
        javaPath = "java";
        del.sync(path.join(javaDownloadPath, "**"), { force: true });
    } else {
        if (!fs.existsSync(javaDownloadPath)) {
            fs.mkdirSync(javaDownloadPath, { recursive: true });
        }
        const javaUrl = Object.entries(JAVA_ZIP_URLS)
            .filter((x) => x[0] === getPlatform())
            .map((x) => x[1])
            .pop();
        if (javaUrl === undefined) {
            return new Err(new Error("Java not found or improperly configured."));
        }

        const javaBinary = getPlatform().startsWith("windows") ? "java.exe" : "java";
        let paths = glob.sync(path.join(javaDownloadPath, "**", javaBinary));

        if (paths.length === 0) {
            const archivePath = path.join(javaDownloadPath, "java.zip");
            if (!fs.existsSync(archivePath)) {
                console.log("Downloading java from", javaUrl, "to", archivePath);
                await downloadFile(javaUrl, archivePath);
                console.log("Java archive downloaded");
            }
            await fs
                .createReadStream(archivePath)
                .pipe(unzipper.Extract({ path: javaDownloadPath }))
                .promise();
            del.sync(archivePath, { force: true });
            console.log("Java archive extracted");
            paths = glob.sync(path.join(javaDownloadPath, "**", "java"));
        }
        if (paths.length === 0) {
            return new Err(new Error("Java not found or improperly configured."));
        }
        javaPath = paths[0];
        fs.chmodSync(javaPath, "755");
    }

    const tmcWorkspacePathRelative = "TMC workspace";
    const tmcWorkspaceFilePathRelative = path.join("TMC workspace", "TMC Exercises.code-workspace");
    const tmcExercisesFolderPathRelative = path.join("TMC workspace", "Exercises");
    const tmcClosedExercisesFolderPathRelative = "closed-exercises";
    const tmcLangsPathRelative = TMC_JAR_NAME;
    const tmcOldSubmissionFolderPathRelative = path.join("TMC workspace", "old-submissions");

    if (!fs.existsSync(tmcDataPath)) {
        fs.mkdirSync(tmcDataPath, { recursive: true });
        const settings = storage.getExtensionSettings() || { dataPath: "" };
        settings.dataPath = tmcDataPath;
        storage.updateExtensionSettings(settings);
        console.log("Created tmc data directory at", tmcDataPath);
    }

    const tmcWorkspacePath = path.join(tmcDataPath, tmcWorkspacePathRelative);
    if (!fs.existsSync(tmcWorkspacePath)) {
        fs.mkdirSync(tmcWorkspacePath);
        console.log("Created tmc workspace directory at", tmcWorkspacePath);
    }

    const tmcWorkspaceFilePath = path.join(tmcDataPath, tmcWorkspaceFilePathRelative);
    if (!fs.existsSync(tmcWorkspaceFilePath)) {
        fs.writeFileSync(tmcWorkspaceFilePath, JSON.stringify(WORKSPACE_SETTINGS));
        console.log("Created tmc workspace file at", tmcWorkspaceFilePath);
    }

    const tmcExercisesFolderPath = path.join(tmcDataPath, tmcExercisesFolderPathRelative);
    if (!fs.existsSync(tmcExercisesFolderPath)) {
        fs.mkdirSync(tmcExercisesFolderPath);
        console.log("Created tmc exercise directory at", tmcExercisesFolderPath);
    }

    if (!fs.existsSync(path.join(tmcExercisesFolderPath, WORKSPACE_ROOT_FILE))) {
        fs.writeFileSync(
            path.join(tmcExercisesFolderPath, WORKSPACE_ROOT_FILE),
            WORKSPACE_ROOT_FILE_TEXT,
        );
        console.log("Wrote tmc root file at", tmcExercisesFolderPath);
    }

    const tmcClosedExercisesFolderPath = path.join(
        tmcDataPath,
        tmcClosedExercisesFolderPathRelative,
    );
    if (!fs.existsSync(tmcClosedExercisesFolderPath)) {
        fs.mkdirSync(tmcClosedExercisesFolderPath);
        console.log("Created tmc closed exercise directory at", tmcClosedExercisesFolderPath);
    }

    const tmcOldSubmissionFolderPath = path.join(tmcDataPath, tmcOldSubmissionFolderPathRelative);

    if (!fs.existsSync(tmcOldSubmissionFolderPath)) {
        fs.mkdirSync(tmcOldSubmissionFolderPath);
        console.log("Created tmc old submissions directory at", tmcOldSubmissionFolderPath);
    }

    const tmcLangsPath = path.join(tmcDataPath, tmcLangsPathRelative);
    if (!fs.existsSync(tmcLangsPath)) {
        del.sync(path.join(tmcDataPath, "*.jar"), { force: true });
        const tmcLangsResult = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "TestMyCode" },
            async (p) => {
                return downloadFile(
                    TMC_JAR_URL,
                    tmcLangsPath,
                    undefined,
                    undefined,
                    (progress: number, increment: number) =>
                        p.report({
                            message: `(${progress}%) Downloading required files`,
                            increment,
                        }),
                );
            },
        );

        if (tmcLangsResult.err) {
            return new Err(tmcLangsResult.val);
        }
        console.log("tmc-langs.jar downloaded");
    }

    const resources: Resources = new Resources(
        storage,
        cssPath,
        extensionVersion,
        htmlPath,
        mediaPath,
        tmcDataPath,
        tmcLangsPathRelative,
        tmcWorkspacePathRelative,
        tmcWorkspaceFilePathRelative,
        tmcExercisesFolderPathRelative,
        tmcClosedExercisesFolderPathRelative,
        tmcOldSubmissionFolderPathRelative,
        javaPath,
    );

    return new Ok(resources);
}
