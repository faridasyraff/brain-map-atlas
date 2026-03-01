import { useState } from "react";
import { Link } from "react-router-dom";

function Navbar() {
    const [isOpen, setIsOpen] = useState(false);

    const links = [
        { to: "/", label: "Home" },
        { to: "/2D-brain", label: "2D Brain" },
        { to: "/atlas", label: "Atlas" },
    ];

    return (
        <nav className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center justify-between relative z-50">
            <h2 className="text-white font-bold text-lg tracking-tight">Brain Atlas</h2>

            {/* Desktop Links */}
            <ul className="hidden md:flex items-center gap-1">
                {links.map((link) => (
                    <li key={link.to}>
                        <Link
                            to={link.to}
                            className="text-gray-400 hover:text-white hover:bg-gray-800 px-3 py-2 rounded-md text-sm transition-colors"
                        >
                            {link.label}
                        </Link>
                    </li>
                ))}
            </ul>

            {/* Hamburger */}
            <button
                className="md:hidden flex flex-col gap-1.5 p-2"
                onClick={() => setIsOpen(!isOpen)}
                aria-label="Toggle navigation"
            >
                <span className={`block w-5 h-0.5 bg-gray-400 transition-all duration-300 ${isOpen ? 'rotate-45 translate-y-2' : ''}`} />
                <span className={`block w-5 h-0.5 bg-gray-400 transition-all duration-300 ${isOpen ? 'opacity-0' : ''}`} />
                <span className={`block w-5 h-0.5 bg-gray-400 transition-all duration-300 ${isOpen ? '-rotate-45 -translate-y-2' : ''}`} />
            </button>

            {/* Mobile Menu */}
            {isOpen && (
                <ul className="absolute top-full left-0 right-0 bg-gray-900 border-b border-gray-800 flex flex-col px-6 py-3 gap-1 md:hidden">
                    {links.map((link) => (
                        <li key={link.to}>
                            <Link
                                to={link.to}
                                onClick={() => setIsOpen(false)}
                                className="block text-gray-400 hover:text-white hover:bg-gray-800 px-3 py-2 rounded-md text-sm transition-colors"
                            >
                                {link.label}
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </nav>
    );
}

export default Navbar;