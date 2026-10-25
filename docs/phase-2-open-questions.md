# Phase 2 — open client questions (design v7 §23)

Tracked copy of the 29 questions in `docs/design/Hajj_Booking_Platform_Architecture_v7.pdf` §23.
Every question has a **working assumption** so the build is never blocked; the implementation follows
the assumption until the client answers. When an answer arrives, record it here (date + answer), and
open a ticket if it changes behaviour.

| # | Topic | Question (v7 §23) | Working assumption (implemented) | Client answer |
|---|---|---|---|---|
| 1 | Booker & price | একটাই অপারেটর (এই ক্লায়েন্ট), নাকি পাবলিক সাইট ভবিষ্যতে একাধিক অপারেটরের মার্কেটপ্লেস? — one operator, or a multi-operator marketplace later? | One operator, one `organization`; agencies and customers live inside it. | |
| 2 | Booker & price | এজেন্সি কি ফ্যামিলি বুকিং করতে পারবে, আর সাধারণ ইউজার কি গ্রুপ? — can agencies book FAMILY and individuals book GROUP? | Yes, both types for both bookers. | |
| 3 | Booker & price | দাম জনপ্রতি, নাকি রুম হিসেবে? — per person or per room? | GROUP: per person per night. FAMILY: per room per night. Extra bed separate. | |
| 4 | Booker & price | জনপ্রতি দামে গ্রুপের রুমে সিট খালি থাকলে সেই সিটের দাম কে দেবে? — who pays an empty seat at per-person pricing? | Nobody (hotel's loss); the allocator minimises empty seats and the shown price never includes them. | |
| 5 | Booker & price | শিশু আর কোলের বাচ্চা কি আলাদা বেড পাবে, দাম কত? — beds/prices for children and infants? | Under 2: no bed, not counted in seats, quota or price (but needs details + check-in). Everyone else is a full pilgrim. | |
| 6 | Booker & price | অনুমোদিত সব এজেন্সির জন্য কি একটা ডিফল্ট এজেন্সি দাম থাকবে? — a default agency price for all approved agencies? | Optional; the WhatsApp quote always works. | |
| 7 | Booker & price | কোটের মেয়াদ কত? আর কোট রুম আটকায় না, সেটা কি ঠিক আছে? — quote validity, and is "a quote does not hold rooms" acceptable? | 48 hours (admin setting); quotes never hold rooms, and the portal says so next to the quote. | |
| 8 | Booker & price | সাধারণ ইউজার কি অনলাইনে পেমেন্ট করবে? — online payment for individuals? | Not in the first version: the booking is `REQUESTED`, a manager confirms it. | |
| 9 | Booker & price | সাধারণ ইউজারের সীমা: রুম, খোলা অনুরোধ, মেয়াদ? — individual limits (rooms per booking, open requests, request lifetime)? | 5 rooms, 1 open request, 24 hours (admin settings). | |
| 10 | Allocation | "একই তারিখ" মানে কি চেক-ইন ও চেক-আউট হুবহু এক? — does "same dates" mean identical check-in and check-out? | Identical. | |
| 11 | Allocation | রুম-মিক্স নিয়ম পুরো গ্রুপের ওপর, নাকি পুরুষ আর মহিলার আলাদা সংখ্যার ওপর? — room-mix rule on the whole group or per gender? | Per gender (separate counts). | |
| 12 | Allocation | গ্রুপে একা একজন মহিলা হলে তাকে পুরো একটা রুম দিতে হবে। তখন ভাড়া কীভাবে? — a lone woman in a group needs a whole room: how is it charged? | Smallest empty room (1–2 seats) first; the charging rule is the client's (per-person price meanwhile). | |
| 13 | Allocation | কোটা কি প্রতি সিজনে নির্দিষ্ট সংখ্যা (শতাংশ নয়)? এজেন্সির ফ্যামিলি বুকিংও কি কোটায় গোনা হবে? — fixed per-season quota (not %)? do agency FAMILY bookings count? | Fixed number per night; every agency booking counts. | |
| 14 | Allocation | এজেন্সির রুমে খালি সিট পড়ে থাকলে কি কোনো সময় অন্যদের জন্য ছেড়ে দেওয়া হবে? — are an agency room's empty seats ever released to others? | No; an admin may release them manually. | |
| 15 | Allocation | এক্সট্রা বেড: দাম কি রুম টাইপ বা সিজনভেদে আলাদা? সিজনাল ক্যাপাসিটির রুমে চলবে? — extra-bed price by type/season; allowed in seasonal-override rooms? | One price per hotel (per policy row); not in seasonal-override rooms (policy flag). | |
| 16 | Allocation | গ্রুপ বুকিং-এ ছোট ছেলে কি মায়ের রুমে থাকতে পারবে? কোন বয়স থেকে আলাদার নিয়ম? — can a young boy stay in his mother's room; from what age does separation apply? | Under 10 may stay in either parent's room (default: mother's side); 10+ in their own gender's room (admin setting). The form asks for children's count and side. | |
| 17 | Allocation | ৪০ জনের বেশি গ্রুপের রুম-মিক্স নিয়ম কী? — room-mix rule above 40? | Same ratio: one more 5+-seat room per additional 10 people. | |
| 18 | Allocation | রুম-মিক্সের সীমা কি "৫ বা তার বেশি সিটের রুম" (হজে ৬ সিট হওয়া রুমসহ), নাকি রুম টাইপের ওপর? — cap on "5+ seat rooms" (incl. Hajj 6-seat) or per room type? | All rooms with 5 or more usable seats together. | |
| 19 | Allocation | যেসব রাত কোনো সিজনে পড়ে না, সেখানে কোটা কী? — quota on nights outside every season? | The default quota row applies; with no row at all, no limit. | |
| 20 | Changes | বাতিল নীতি: কত দিন আগে বাতিল করলে কত চার্জ? — cancellation charges? | Client to decide; meanwhile only a manager cancels, without charge. | |
| 21 | Changes | এজেন্সি কোন বদল নিজে করতে পারবে? — which changes can an agency make itself? | Adding pilgrims itself; removals, date/room changes and cancellation need a manager. | |
| 22 | Changes | No-show বা আগে চেক-আউট হলে টাকা ফেরত হবে? সিট ছেড়ে দেওয়া হবে? — refunds and seat release on no-show/early checkout? | No refund. Early checkout frees the remaining nights; no-show: the manager decides. | |
| 23 | Pilgrim data | এজেন্সি নাম ছাড়া রুম আটকে রাখতে পারলে অপব্যবহারের ঝুঁকি। তথ্যের শেষ সময় বা অগ্রিম টাকা লাগবে? — abuse risk of nameless agency bookings: deadline or deposit? | Bounded by quota; reminder 7 days before check-in; no automatic cancellation. Deposit is the client's call. | |
| 24 | Pilgrim data | পাসপোর্টের ছবি বাইরের AI সার্ভিসে পাঠানো যাবে কি? — may passport images go to an external AI service? | Only as a fallback, after contract/data-region review; on-server MRZ + OCR first. Disabled by default. | |
| 25 | Pilgrim data | পাসপোর্টের ছবি কতদিন রাখা হবে? এনক্রিপশন কী কে রাখবে? — image retention and key custody? | Images deleted 12 months after checkout; keys in the cloud KMS (env key in development). | |
| 26 | Pilgrim data | পাসপোর্টের ন্যূনতম মেয়াদ কত হতে হবে? — minimum passport validity? | 6 months from check-in (admin setting); the client confirms the current Saudi rule. | |
| 27 | Other | সার্ভার কোথায় রাখা হবে: সৌদির ভেতরে, নাকি বাহরাইন বা UAE-তে? — hosting region? | An in-Kingdom cloud region until PDPL legal advice says otherwise. | |
| 28 | Other | অকুপেন্সি ক্যালেন্ডার কি রিসেপশনও দেখতে পারবে? — may reception see the occupancy calendar? | Implemented: Reception (`occupancy.view`, which it holds with `pilgrim.view`) sees the year, month and day views, read-only. The year and month views show counts only; the day view names the bookers and, with `pilgrim.view`, the pilgrims. Passport numbers are never shown. Limiting Reception to the day view would take one new permission key (the range views share `occupancy.view`), pending the client. | |
| 29 | Other | ট্রান্সপোর্ট সিস্টেম কোন ফেজে আসবে? — which phase brings transport? | After Phase 2, as an ops-console section (separate module, consumes booking slots/events). | |
