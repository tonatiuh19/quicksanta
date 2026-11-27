/** "7k4pqx9m" → "7K4P-QX9M" while typing (codes use an unambiguous alphabet: no 0/O/1/I). */
export function formatCodeInput(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}
export const isCompleteCode = (formatted: string) => formatted.replace("-", "").length === 8;
