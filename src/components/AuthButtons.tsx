export function SignInButton() {
  return <a className="btn primary" href="/api/auth/login">Google でログイン</a>;
}

export function SignOutButton() {
  return (
    <form action="/api/auth/logout" method="post">
      <button className="btn">ログアウト</button>
    </form>
  );
}
