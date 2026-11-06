import * as path from "path";
/**
 * Returns true if a name from a directory listing can only refer to an entry directly inside a
 * local directory when joined with its path.
 */
export declare function isSafePathName(name: string, localPath?: typeof path): boolean;
