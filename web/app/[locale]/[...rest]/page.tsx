// Any address under a language that no page answers: the site's own 404 page, inside the header and footer.
import { notFound } from "next/navigation";

export default function CatchAll() {
  notFound();
}
