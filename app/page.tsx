import { Providers } from "./providers";
import { BookingApp } from "@/components/BookingApp";

export default function Home() {
  return (
    <Providers>
      <BookingApp />
    </Providers>
  );
}
