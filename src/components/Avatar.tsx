import type { UserSummary } from '../../shared/types';

/** `src` overrides where the photo comes from (the other account in a merge isn't a friend, so it has its own route). */
export default function Avatar({ user, size = 40, src }: { user: Pick<UserSummary, 'id' | 'name' | 'hasAvatar' | 'avatarVersion'>; size?: number; src?: string }) {
  const style = { width: size, height: size, fontSize: size * 0.4 };
  if (user.hasAvatar) {
    return <img className="avatar" style={style} src={src ?? `/api/users/${user.id}/avatar?v=${user.avatarVersion}`} alt="" />;
  }
  const initials = user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <span className="avatar avatar-initials" style={style} aria-hidden="true">
      {initials}
    </span>
  );
}
