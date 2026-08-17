declare module "diff" {
  export function applyPatch(source: string, patch: string): string | false;

  export function createTwoFilesPatch(
    oldPath: string,
    newPath: string,
    before: string,
    after: string,
    oldHeader?: string,
    newHeader?: string,
    options?: { context?: number },
  ): string;
}
