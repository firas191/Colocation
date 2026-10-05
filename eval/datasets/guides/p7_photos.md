# Labelling guide: P7 photo analyzer (golden set p7_photos v1)

One label per photo, written from the **blurred copy** the model sees (the Media service's processing: faces, text
regions and screens blurred, then a copy whose long side is 1,024 px). The labels say what a careful person can see
in that copy, not what the room probably has. Field names and lists are those of `prompts/schemas/P7_photo_analyzer.v2.schema.json`.

## Values

- **A value**: what the photo shows.
- **null**: the photo does not let anyone answer (too dark, the part of the room is out of view). The right answer is
  then `not_visible`; any value counts as unsupported.
- **`*`**: the field does not apply to this photo and is not scored (furnished for a kitchen; beds, windows, light,
  condition and furnished for something that is not a room).
- **`<field>_alt`**: other answers that are also right when a careful person could read the photo either way
  (for example `room_type_alt: ["studio"]` for a bedroom with a dining corner, `windows_alt: [2]` when a window could be
  one wide window or two).
- Object lists: `furniture`, `appliances`, `bathroom_fixtures`, `bed_kinds`, `condition_signs` hold the objects that
  are clearly visible; `<list>_maybe` holds those that are partly visible or hard to identify. A `_maybe` object in an
  answer is neither a hit nor a hallucination; missing it is not a miss.

## Fields

- **room_type**: the room the photo is mostly of. `studio`: bed and kitchen in one room. `other_room`: a room of a home
  that is none of the listed types (attic store room, empty room whose use cannot be told, room under works).
  `not_a_room`: outside of a building, floor plan, drawing, 3D render, close-up of an object.
- **beds**: number of beds visible. A bunk bed is one bed (`bed_kinds: bunk`). Two single beds pushed together are two.
  0 when the room in view clearly has none; null when clutter could hide a bed (settled after the re-label).
  `*` for not_a_room.
- **windows**: windows visible in the room, including glazed doors to a balcony. A wall of glass split into a few large
  frames: the number of frames, with `_alt` for the other reasonable count. A skylight counts. `*` for not_a_room.
- **natural_light**: `good` bright daylight, `some` daylight but dim or a small window, `none` no daylight visible
  (lamps only, night). Without a window in view, `none` only when a lamp is visible or it is clearly night; otherwise
  null (settled after the re-label).
- **condition**: `good` clean and intact; `fair` worn, dated or untidy but sound; `poor` damaged, dirty, under works or
  unusable. condition_signs only when visible. Glare or darkness makes condition null only when walls and floor
  cannot be seen (settled after the re-label).
- **furnished**: for bedrooms, living rooms, studios and other rooms: `yes` furnished for living in, `partly` a few
  pieces, `no` empty. `*` for kitchens, bathrooms, hallways, balconies and not_a_room.
- **readable_text**: true when at least one word or number can still be read in the blurred copy (signs, plans,
  labels, posters). Text in a language or script the annotator does not read still counts when it is clearly text.
- **people_visible**: true when a real person is in view, however small. Statues, mannequins, paintings and photos
  of people are not people.

## Tags (first tag is the group)

Group: `bedroom`, `kitchen`, `living`, `bathroom`, `other`, `not_a_room`. Then any of: `dark` (low light or strong
glare), `people`, `text`, `poor_condition`, `clutter`, `bunk`, `historic` (old or black-and-white photo), `render`.

## Agreement

A random 20% (10 photos, seed 20261005) was labelled again blind by a second model-based annotator from this guide
and the images only (`relabel/p7_photos_v1_blind.jsonl`, `_relabel.jsonl`). Before adjudication: room_type 10 of 10;
beds 8, windows 9, natural_light 8, condition 9, furnished 9, readable_text 10, people_visible 9 of 10 strictly equal
(9 to 10 of 10 counting each other's alternatives); mean Jaccard of the clearly visible objects 0.833, and no object
marked clear by one annotator was absent from the other's labels. The three conflicts led to the three rules marked
above; `relabel/p7_photos_v1_adjudication.json` lists the 8 label changes. Both annotators are models: this measures
how much room the guide leaves, not human agreement.
