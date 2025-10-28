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
  constructor(private readonly prisma: PrismaService) { }

  inferCategory(listName: string, attrs: Record<string, any>): string | null {
    let inferredCategory: string | null = null;
    const inList = (v: any, allowed: string[]) =>
      typeof v === 'string' &&
      allowed.map((a) => a.toLowerCase()).includes(v.toLowerCase());

    if (listName === 'activity') {
      const allowed = [
        'Run',
        'Bike',
        'Swim',
        'Strength',
        'Hike',
        'Walk',
        'Tennis',
        'Pickleball',
        'Group Sport',
        'Other',
      ];
      if (inList(attrs.activityType, allowed))
        inferredCategory = String(attrs.activityType)
          .toLowerCase()
          .replace(' ', '_');
    } else if (listName === 'health') {
      if (
        typeof attrs.total_steps === 'number' ||
        typeof attrs.steps === 'number'
      )
        inferredCategory = 'Steps';
      else if (typeof attrs.bpm === 'number') inferredCategory = 'Heart Rate';
      else if (
        typeof attrs.vo2_max === 'number' ||
        typeof attrs.vo2 === 'number'
      )
        inferredCategory = 'VO2 Max';
      else if (
        typeof attrs.sleep_total_time === 'number' ||
        typeof attrs.sleepMinutes === 'number' ||
        typeof attrs.sleep_hours === 'number'
      )
        inferredCategory = 'Sleep';
      else if (
        typeof attrs.miles === 'number' ||
        typeof attrs.distance_miles === 'number' ||
        typeof attrs.yards === 'number'
      )
        inferredCategory = 'Miles';
    } else if (listName === 'travel') {
      if (typeof attrs.country === 'string') inferredCategory = 'International';
      else if (typeof attrs.state === 'string') inferredCategory = 'Domestic';
    } else if (listName === 'food') {
      const allowed = [
        'Coffee shops',
        'Breakfast',
        'Lunch',
        'Dinner',
        'Sweet treats',
        'Drinks',
      ];
      if (inList(attrs.category, allowed))
        inferredCategory = String(attrs.category)
          .toLowerCase()
          .replace(' ', '_');
    } else if (listName === 'transport') {
      const allowed = ['Public transport', 'Rideshare', 'Airplane', 'Car'];
      if (inList(attrs.category, allowed))
        inferredCategory = String(attrs.category)
          .toLowerCase()
          .replace(' ', '_');
    } else if (
      listName === 'places visited' ||
      listName === 'places_visited' ||
      listName === 'places'
    ) {
      const allowed = ['Grocery store', 'Park', 'Museum', 'Friends home'];
      if (inList(attrs.category, allowed))
        inferredCategory = String(attrs.category)
          .toLowerCase()
          .replace(' ', '_');
      else if (attrs.items) inferredCategory = 'Grocery store';
    } else if (listName === 'events') {
      const allowed = [
        'Party',
        'Get together',
        'Birthday',
        'Concert',
        'Show',
        'Sports event',
        'Reunion',
        'Housewarming',
        'Graduation',
        'Wedding',
        'Other',
      ];
      if (inList(attrs.category, allowed))
        inferredCategory = String(attrs.category)
          .toLowerCase()
          .replace(' ', '_');
    } else {
      inferredCategory = null;
    }

    return inferredCategory;
  }

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
          $5::text,
          $6::text
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

  formatDate(date: string | Date): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  formatDateTimeToUtc(date: Date): Date {
    const utcTime = new Date(date.toISOString());
    return utcTime;
  }
}
