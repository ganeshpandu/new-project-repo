import { Injectable } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { Response } from '../../constants';
import { PrismaService } from '@traeta/prisma';

interface UpdateEntityInput {
  dbname: string;
  tablename: string;
  updateData: Record<string, any>;
  primaryKeyCriteria: Partial<Record<string, any>>;
  requestId: string;
  username: string;
}

interface UpdateEntityDbResponseRow {
  response: { status: number; message: unknown } | null;
}

@Injectable()
export class UtilityService {
  constructor(private readonly prisma: PrismaService) {}

  buildFilter(
    rawFilter: Record<string, any>,
    excludeKeys: string[],
  ): Record<string, any> {
    const filters: Record<string, any> = {};
    for (const key in rawFilter) {
      if (
        Object.prototype.hasOwnProperty.call(rawFilter, key) &&
        !excludeKeys.includes(key) &&
        rawFilter[key] !== undefined &&
        rawFilter[key] !== null &&
        rawFilter[key] !== ''
      ) {
        const value = (rawFilter as Record<string, unknown>)[key];
        filters[key] = Array.isArray(value) ? { in: value } : value;
      }
    }
    return filters;
  }

  async updateEntity(
    updateEntityInput: UpdateEntityInput,
  ): Promise<Response<any>> {
    const response: Response<any> = { status: HttpStatus.OK, data: '' };

    try {
      const data = await this.prisma.$queryRawUnsafe<
        UpdateEntityDbResponseRow[]
      >(
        `
        SELECT updateEntity(
          $1::text,
          $2::text,
          $3::jsonb,
          $4::jsonb,
          $5::uuid,
          $6::uuid
        ) AS response
      `,
        updateEntityInput.dbname,
        updateEntityInput.tablename,
        JSON.stringify(updateEntityInput.updateData),
        JSON.stringify(updateEntityInput.primaryKeyCriteria),
        updateEntityInput.requestId,
        updateEntityInput.username,
      );

      // Our function returns a JSONB object {status, message}
      const responsePart = data[0]?.response;

      if (!responsePart || typeof responsePart.status !== 'number') {
        response.status = HttpStatus.INTERNAL_SERVER_ERROR;
        response.data = 'Unexpected response from updateEntity';
        return response;
      }

      response.status = responsePart.status as HttpStatus;
      if (responsePart.status === 400 || responsePart.status === 500) {
        response.data = String(responsePart.message);
      } else {
        // message holds the updated row JSON
        const parsedMessage: unknown =
          typeof responsePart.message === 'string'
            ? (JSON.parse(responsePart.message) as unknown)
            : responsePart.message;
        response.data = parsedMessage;
      }

      return response;
    } catch (error) {
      response.status = HttpStatus.INTERNAL_SERVER_ERROR;
      response.data = (error as Error).message;
      return response;
    }
  }
}
