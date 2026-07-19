/**
 * SQLite's built-in identifier comparison folds ASCII A-Z only. JavaScript
 * lowercasing would merge distinct identifiers such as Ä/ä or K/k.
 */
export function foldSqliteIdentifier(name: string): string {
  return name.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32)
  );
}
