import { NavLink } from 'react-router-dom';

/** Brand Console areas. */
export function BrandNav() {
  return (
    <nav className="brand-nav" aria-label="Brand Console">
      <NavLink to="/brand" end>
        Overview
      </NavLink>
      <NavLink to="/brand/conversations">Conversations & intents</NavLink>
    </nav>
  );
}
