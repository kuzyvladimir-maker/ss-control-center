[← Wiki index](index.md)

# Sidebar по орг-схеме (7 отделений)

Левый сайдбар Командного центра сгруппирован по **семи отделениям** организационной схемы Л. Рона Хаббарда (секулярная бизнес-модель). Утверждён вариант **«Канон»** (Владимир, 2026-06-21).

Полная раскладка модулей по отделениям: [command-center-orgboard.md](lrh-green-volumes/command-center-orgboard.md).
Превью с двумя вариантами дизайна: `design/sidebar_orgboard_preview.html` (вариант A «Канон» + вариант B «Рабочий поток»).

## Что сделано
- **Компонент:** `ss-control-center/src/components/layout/SidebarContent.tsx`.
- **Порядок отделений** сверху вниз — как поток частицы на орг-доске: **7 → 1 → 2 → 3 → 4 → 5 → 6**.
- Каждое отделение — блок с цветной левой полосой, номером-бейджем и названием; **сворачивается/разворачивается стрелкой** (состояние в памяти, сбрасывается при полной перезагрузке).
- **Названия отделений — на английском** (правило: UI на английском): Executive, Communications, Dissemination, Treasury, Production, Qualifications, Public.

## Раскладка модулей (решения 2026-06-21)
- **7 Executive:** Dashboard
- **1 Communications:** Reference Catalog, Settings *(admin-only — раньше был приколот внизу, теперь внутри Отд 1)*
- **2 Dissemination:** Amazon Growth, Walmart Growth, A+ Content, Product listings *(Soon)*
- **3 Treasury:** Financial Plan, Economics, **Sales overview**
- **4 Production:** Procurement, Suppliers *(Soon)*, Bundle Factory, Shipping labels
- **5 Qualifications:** Account Health, **Frozen analytics**, **Adjustments**
- **6 Public:** Customer hub

Изменения относительно старой плоской раскладки: Frozen analytics и Adjustments переехали в Отд 5; Sales overview — в Отд 3.

## Заодно убрано (мусор)
- Версия `· v1.4` в брендблоке — удалена.
- Подпись брендблока → **Command Center** (было «Control · v1.4»).
- Нижняя карточка «Daily plan ready / shipments queued» — удалена.

## Связанное
- [Бэклог идей](ideas-backlog.md) — пробелы орг-доски (лидоген Отд 6, обучение персонала Отд 5).
