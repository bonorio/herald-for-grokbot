import { createContext, useContext, useEffect, useState } from "react";
import { ALERT_TYPES, type AlertType, alertHeading, alertType, type Category, type CategoryIcon, type Notification } from "../shared/types";
import { request } from "./api";

/** Every category by id, for labels and colors anywhere in the tree. */
export const CategoriesContext = createContext<Map<string, Category>>(new Map());

/** The category list, refetched whenever `tick` changes (each inbox reload). */
export function useCategories(tick: number, initial: Category[] | null = null) {
  const [categories, setCategories] = useState<Category[] | null>(initial);
  useEffect(() => {
    let live = true;
    request<{ items: Category[] }>("/api/categories")
      .then((r) => live && setCategories(r.items))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [tick]);
  return categories;
}

/** Uncategorized cards fall back to a color per kind of alert. */
export const TYPE_COLORS: Record<AlertType, string> = {
  email: "#0a84ff",
  payment: "#34c759",
  event: "#ff9f0a",
  question: "#bf5af2",
  alert: "#ff375f",
  result: "#30b0c7",
  update: "#8e8e93",
};

export interface Filing {
  /** A category id, or `type:<alert type>` for an uncategorized card. */
  key: string;
  label: string;
  plural: string;
  color: string;
  category: Category | null;
}

export function filingOf(n: Notification, categories: Map<string, Category>): Filing {
  const category = n.category ? categories.get(n.category) : undefined;
  if (category) return { key: category.id, label: category.name, plural: category.name, color: category.color, category };
  const type = alertType(n);
  return { key: `type:${type}`, label: ALERT_TYPES[type].label, plural: ALERT_TYPES[type].plural, color: TYPE_COLORS[type], category: null };
}

/** "Email from Jordan Lee" or "Payment to Duke Energy" when it's about one, else its category. */
export function headingOf(n: Notification, categories: Map<string, Category>): string {
  return n.subject?.type === "email" || n.subject?.type === "payment" ? alertHeading(n) : filingOf(n, categories).label;
}

export function useFiling(n: Notification): Filing {
  return filingOf(n, useContext(CategoriesContext));
}

const ICONS: Record<CategoryIcon, React.ReactNode> = {
  person: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 19.5c1.2-3.4 3.8-5 7-5s5.8 1.6 7 5" />
    </>
  ),
  briefcase: (
    <>
      <rect height="12" rx="2.5" width="18" x="3" y="7.5" />
      <path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3 13h18" />
    </>
  ),
  card: (
    <>
      <rect height="14" rx="2.5" width="18" x="3" y="5" />
      <path d="M3 10h18M7 15h4" />
    </>
  ),
  calendar: (
    <>
      <rect height="15" rx="2.5" width="18" x="3" y="5" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  heart: <path d="M12 19.5s-7.5-4.4-7.5-9.8A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.4c0 5.4-7.5 9.8-7.5 9.8z" />,
  house: (
    <>
      <path d="M4 11l8-6.5 8 6.5" />
      <path d="M6 9.5V19a1 1 0 0 0 1 1h3.5v-5h3v5H17a1 1 0 0 0 1-1V9.5" />
    </>
  ),
  plane: <path d="M10.5 13.5L4 11l1.5-1.5 7 1 4-4a1.8 1.8 0 0 1 2.5 2.5l-4 4 1 7L16.5 21 14 14.5l-3 3v2.5L9.5 21 8 17.5 4.5 16 6 14.5h2.5z" />,
  bag: (
    <>
      <path d="M5 8h14l-1 12H6z" />
      <path d="M9 10V7a3 3 0 0 1 6 0v3" />
    </>
  ),
  news: (
    <>
      <rect height="16" rx="2.5" width="16" x="4" y="4" />
      <path d="M8 8.5h8M8 12h8M8 15.5h5" />
    </>
  ),
  tag: (
    <>
      <path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9z" />
      <circle cx="8" cy="8" r="1.3" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  star: <path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4.1-4 5.7-.8z" />,
};

export function CategoryGlyph({ icon, className = "category-icon" }: { icon: CategoryIcon; className?: string }) {
  return (
    <svg aria-hidden className={className} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
      {ICONS[icon]}
    </svg>
  );
}
