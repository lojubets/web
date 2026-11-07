/**
 * Which friends start out ticked on the "New bet" form.
 *
 * - Coming from a friend's page (`?with=<id>`): that friend, if they're still available.
 * - With exactly one friend to choose from: that friend, since there's nobody else to bet with.
 * - With several friends: nobody, so we don't assume which of them the bet is for.
 */
export function initialPick(availableIds: string[], withId: string | null): string[] {
  if (withId !== null) return availableIds.includes(withId) ? [withId] : [];
  return availableIds.length === 1 ? [availableIds[0]] : [];
}
