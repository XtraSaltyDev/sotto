import path from 'node:path';

export interface SidecarTarget {
  executableName: string;
  resourceDirectory: string;
}

export const resolveWhisperSidecarTarget = (
  platform: NodeJS.Platform,
  arch: string,
): SidecarTarget | null => {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return {
      executableName: 'whisper-cli',
      resourceDirectory: path.join('sidecars', `darwin-${arch}`),
    };
  }

  if (platform === 'win32' && arch === 'x64') {
    return {
      executableName: 'whisper-cli.exe',
      resourceDirectory: path.join('sidecars', 'win32-x64'),
    };
  }

  return null;
};
