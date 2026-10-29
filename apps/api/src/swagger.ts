import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

/** Swagger UI ที่ /docs และ JSON ที่ /docs-json */
export function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle("SDES API")
    .setDescription("Smart Document Extraction & ERP Sync")
    .setVersion("0.1.0")
    .addBearerAuth()
    .build();
  SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, config), { jsonDocumentUrl: "docs-json" });
}
