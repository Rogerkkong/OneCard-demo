// Imported first by the single-file app (src/app/sea-main.js), before anything loads node:sqlite.
// `npm start` passes --disable-warning=ExperimentalWarning; a single executable cannot be given
// Node options, so without this every start would print "SQLite is an experimental feature",
// which means nothing to the people using the app. Only that one warning is dropped.
//
// Node prints the warning through process.emitWarning, read when the warning is emitted, so
// wrapping it here works as long as this module is evaluated before node:sqlite is required:
// scripts/build-sea.mjs checks that order in the bundle.

const emitWarning = process.emitWarning;

/** Whether a warning is node:sqlite's "experimental feature" notice. */
export function isSqliteNotice(warning, typeOrOptions) {
  const type = typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions?.type;
  const name = typeof warning === 'object' && warning !== null ? warning.name : type;
  const text = typeof warning === 'string' ? warning : warning?.message;
  return (type === 'ExperimentalWarning' || name === 'ExperimentalWarning') && /\bSQLite\b/i.test(String(text ?? ''));
}

process.emitWarning = function emitWarningExceptSqlite(warning, ...rest) {
  if (isSqliteNotice(warning, rest[0])) return undefined;
  return emitWarning.call(this, warning, ...rest);
};
