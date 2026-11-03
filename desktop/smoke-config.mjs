export function configureSmokeMedia(commandLine, args) {
    if (args.includes("--smoke-test")) commandLine.appendSwitch("use-fake-device-for-media-stream");
}
